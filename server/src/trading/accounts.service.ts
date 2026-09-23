import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { nowIso, ulid } from '../common/ids';
import type { Account, ClosedPosition, EquityPoint, Fill, LedgerEntry } from '../domain/types';
import { AccountMetricsService } from './account-metrics.service';
import {
  ACCOUNT_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  TradingStore,
} from './trading.store';
import type {
  CreateAccountDto,
  EquityCurveDto,
  OrderFilterDto,
  PaginationDto,
} from './dto/trading.dto';

const MAX_ACCOUNTS_PER_USER = 10;
const MAX_EQUITY_POINTS = 1000;

@Injectable()
export class AccountsService {
  constructor(
    private readonly store: TradingStore,
    private readonly metrics: AccountMetricsService,
  ) {}

  createAccount(userId: string, dto: CreateAccountDto): Account {
    const template = ACCOUNT_TEMPLATES[dto.templateId] ?? ACCOUNT_TEMPLATES[DEFAULT_TEMPLATE_ID];
    const existing = this.store.listAccountRowsForUser(userId);
    if (existing.length >= MAX_ACCOUNTS_PER_USER) {
      throw ApiError.unprocessable(
        `Account limit reached (${MAX_ACCOUNTS_PER_USER})`,
        'ACCOUNT_LIMIT',
      );
    }
    const now = nowIso();
    const id = ulid();
    this.store.createAccount({
      id,
      userId,
      templateId: template.id,
      label: dto.label ?? null,
      balance: template.startingBalance,
      leverage: template.leverage,
      phase: template.phase,
      startDate: now,
      createdAt: now,
      updatedAt: now,
    });
    this.store.insertEquityPoint(id, template.startingBalance, template.startingBalance, now);
    return this.getAccount(userId, id);
  }

  listAccounts(userId: string): Account[] {
    return this.store
      .listAccountRowsForUser(userId)
      .map((row) => this.metrics.decorateAccount(row.id))
      .filter((account): account is Account => account !== null);
  }

  getAccount(userId: string, accountId: string): Account {
    const row = this.store.getAccountRow(accountId);
    if (!row) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');
    if (row.user_id !== userId) {
      throw ApiError.forbidden('This account belongs to another user', 'ACCOUNT_FORBIDDEN');
    }
    const account = this.metrics.decorateAccount(accountId);
    if (!account) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');
    return account;
  }

  ledger(
    userId: string,
    accountId: string,
    pagination: PaginationDto,
  ): { data: LedgerEntry[]; total: number; page: number; pageSize: number } {
    this.getAccount(userId, accountId);
    const page = pagination.page ?? 1;
    const pageSize = pagination.pageSize ?? 50;
    const result = this.store.listLedgerForAccount(accountId, page, pageSize);
    return { data: result.entries, total: result.total, page, pageSize };
  }

  fills(
    userId: string,
    accountId: string,
    pagination: PaginationDto,
  ): { data: Fill[]; total: number; page: number; pageSize: number } {
    this.getAccount(userId, accountId);
    const page = pagination.page ?? 1;
    const pageSize = pagination.pageSize ?? 50;
    const result = this.store.listFillsForAccount(accountId, page, pageSize);
    return { data: result.fills, total: result.total, page, pageSize };
  }

  orders(
    userId: string,
    accountId: string,
    filter: OrderFilterDto,
  ): { data: unknown[]; total: number; page: number; pageSize: number } {
    this.getAccount(userId, accountId);
    const page = filter.page ?? 1;
    const pageSize = filter.pageSize ?? 50;
    const result = this.store.listOrdersForAccount(accountId, {
      status: filter.status,
      page,
      pageSize,
    });
    return { data: result.orders, total: result.total, page, pageSize };
  }

  closedPositions(userId: string, accountId: string): ClosedPosition[] {
    this.getAccount(userId, accountId);
    return this.store.listClosedPositionsForAccount(accountId);
  }

  equityCurve(userId: string, accountId: string, query: EquityCurveDto): EquityPoint[] {
    this.getAccount(userId, accountId);
    const points = this.store.listEquityPoints(accountId, query.fromMs, query.toMs);
    if (points.length <= MAX_EQUITY_POINTS) {
      return points.map((point) => ({
        equity: point.equity,
        balance: point.balance,
        timestamp: point.timestamp,
      }));
    }
    // uniform downsample for chart-friendly payloads
    const stride = points.length / MAX_EQUITY_POINTS;
    const sampled: EquityPoint[] = [];
    for (let i = 0; i < MAX_EQUITY_POINTS; i++) {
      const point = points[Math.floor(i * stride)];
      sampled.push({
        equity: point.equity,
        balance: point.balance,
        timestamp: point.timestamp,
      });
    }
    return sampled;
  }
}
