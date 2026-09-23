import { Injectable } from '@nestjs/common';
import type { User } from '../domain/types';
import { DatabaseService } from '../persistence/database.service';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  roles: string;
  status: string;
  is_demo: number;
  created_at: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    roles: JSON.parse(row.roles) as string[],
    status: row.status,
    createdAt: row.created_at,
  };
}

@Injectable()
export class AuthStore {
  constructor(private readonly db: DatabaseService) {}

  private get users() {
    return this.db.prepare(
      'SELECT id, email, password_hash, first_name, last_name, roles, status, is_demo, created_at FROM users',
    );
  }

  createUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    firstName?: string | null;
    lastName?: string | null;
    roles?: string[];
    isDemo?: boolean;
    createdAt: string;
  }): User {
    this.db
      .prepare(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, roles, status, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .run(
        input.id,
        input.email.toLowerCase(),
        input.passwordHash,
        input.firstName ?? null,
        input.lastName ?? null,
        JSON.stringify(input.roles ?? ['trader']),
        input.isDemo ? 1 : 0,
        input.createdAt,
      );
    return this.getUserByEmail(input.email) as User;
  }

  getUserByEmail(email: string): User | null {
    const row = this.db
      .prepare<UserRow>('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare<UserRow>('SELECT * FROM users WHERE id = ?').get(id) as
      | UserRow
      | undefined;
    return row ? rowToUser(row) : null;
  }

  getPasswordHash(email: string): string | null {
    const row = this.db
      .prepare<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = ?')
      .get(email.toLowerCase()) as { password_hash: string } | undefined;
    return row?.password_hash ?? null;
  }

  // ── refresh tokens ──────────────────────────────────────────────────────

  saveRefreshToken(record: RefreshTokenRecord): void {
    this.db
      .prepare(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.userId, record.tokenHash, record.expiresAt, record.createdAt);
  }

  findRefreshToken(tokenHash: string): RefreshTokenRecord | null {
    const row = this.db
      .prepare<{ id: string; user_id: string; token_hash: string; expires_at: number; created_at: number }>('SELECT id, user_id, token_hash, expires_at, created_at FROM refresh_tokens WHERE token_hash = ?')
      .get(tokenHash) as
      | { id: string; user_id: string; token_hash: string; expires_at: number; created_at: number }
      | undefined;
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          tokenHash: row.token_hash,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        }
      : null;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(tokenHash);
  }

  deleteRefreshTokenById(id: string): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(id);
  }

  purgeExpiredRefreshTokens(now: number): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now);
  }

  /** Demo users and their data older than the given age (ms). */
  purgeStaleDemoUsers(cutoffMs: number): number {
    const cutoff = new Date(cutoffMs).toISOString();
    const result = this.db.prepare('DELETE FROM users WHERE is_demo = 1 AND created_at < ?').run(cutoff);
    return Number(result.changes ?? 0);
  }
}
