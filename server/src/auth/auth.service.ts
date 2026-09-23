import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { CONFIG, type AppConfig } from '../config/configuration';
import { ApiError } from '../common/api-error';
import { ulid } from '../common/ids';
import type { User } from '../domain/types';
import { AuthStore, type RefreshTokenRecord } from './auth.store';
import { AccountsService } from '../trading/accounts.service';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends TokenPair {
  user: User;
}

const BCRYPT_ROUNDS = 10;
const DEMO_USER_TTL_MS = 7 * 24 * 3600 * 1000;
import { DEFAULT_TEMPLATE_ID } from '../trading/trading.store';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly store: AuthStore,
    private readonly jwt: JwtService,
    private readonly accountsService: AccountsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async register(input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }): Promise<AuthResponse> {
    if (this.store.getUserByEmail(input.email)) {
      throw ApiError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = this.store.createUser({
      id: ulid(),
      email: input.email,
      passwordHash,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      createdAt: new Date().toISOString(),
    });
    this.accountsService.createAccount(user.id, { templateId: DEFAULT_TEMPLATE_ID });
    const tokens = await this.issueTokens(user);
    return { ...tokens, user };
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const user = this.store.getUserByEmail(email);
    const hash = user ? this.store.getPasswordHash(email) : null;
    // Always run a comparison to avoid user-enumeration timing signals.
    const reference = hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const matches = await bcrypt.compare(password, reference);
    if (!user || !hash || !matches) {
      throw ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    const tokens = await this.issueTokens(user);
    return { ...tokens, user };
  }

  /**
   * One-click demo access: provisions a throwaway user with a fresh paper
   * account, so anyone can explore the terminal without signing up.
   */
  async demoLogin(): Promise<AuthResponse> {
    const email = `demo-${ulid().toLowerCase()}@kryptto.local`;
    const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), BCRYPT_ROUNDS);
    const user = this.store.createUser({
      id: ulid(),
      email,
      passwordHash,
      firstName: 'Demo',
      lastName: 'Trader',
      isDemo: true,
      createdAt: new Date().toISOString(),
    });
    this.accountsService.createAccount(user.id, { templateId: DEFAULT_TEMPLATE_ID });
    const tokens = await this.issueTokens(user);
    return { ...tokens, user };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = this.hash(refreshToken);
    const record = this.store.findRefreshToken(tokenHash);
    if (!record) {
      throw ApiError.unauthorized('Refresh token not recognized', 'REFRESH_INVALID');
    }
    if (record.expiresAt < Date.now()) {
      this.store.deleteRefreshTokenById(record.id);
      throw ApiError.unauthorized('Refresh token expired', 'REFRESH_EXPIRED');
    }
    const user = this.store.getUser(record.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw ApiError.unauthorized('Account is no longer active', 'ACCOUNT_INACTIVE');
    }

    // Rotation: the presented token is revoked and replaced.
    this.store.deleteRefreshTokenById(record.id);
    return this.issueTokens(user);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) {
      this.store.deleteRefreshToken(this.hash(refreshToken));
    }
    this.store.purgeExpiredRefreshTokens(Date.now());
  }

  me(userId: string): User {
    const user = this.store.getUser(userId);
    if (!user) {
      throw ApiError.unauthorized('User no longer exists');
    }
    return user;
  }

  verifyAccessToken(token: string): JwtPayload {
    return this.jwt.verify<JwtPayload>(token);
  }

  async verifyAccessTokenAsync(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token);
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      type: 'access',
    };
    const accessToken = await this.jwt.signAsync(payload, {
      // ms-style string ("15m"); cast needed for jsonwebtoken's StringValue type
      expiresIn: this.config.jwt.accessTtl as never,
    });

    const refreshToken = randomBytes(48).toString('hex');
    const record: RefreshTokenRecord = {
      id: ulid(),
      userId: user.id,
      tokenHash: this.hash(refreshToken),
      expiresAt: Date.now() + this.config.jwt.refreshTtlSeconds * 1000,
      createdAt: Date.now(),
    };
    this.store.saveRefreshToken(record);
    return { accessToken, refreshToken };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Called at boot: clean up expired sessions and stale demo users. */
  cleanup(): void {
    this.store.purgeExpiredRefreshTokens(Date.now());
    const purged = this.store.purgeStaleDemoUsers(Date.now() - DEMO_USER_TTL_MS);
    if (purged > 0) {
      this.logger.log(`Purged ${purged} stale demo user(s)`);
    }
  }
}
