import { Injectable } from '@nestjs/common';
import type {
  Account,
  AccountTemplate,
  ClosedPosition,
  Fill,
  LedgerEntry,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  PositionSide,
} from '../domain/types';
import { DatabaseService } from '../persistence/database.service';

// ── row types (snake_case → domain mapping lives here) ────────────────────

interface AccountRow {
  id: string;
  user_id: string;
  template_id: string;
  label: string | null;
  status: string;
  balance: number;
  phase: string;
  leverage: number;
  start_date: string;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  account_id: string;
  symbol_name: string;
  side: string;
  type: string;
  quantity: number;
  price: number | null;
  stop_price: number | null;
  take_profit: number | null;
  stop_loss: number | null;
  status: string;
  filled_quantity: number;
  avg_fill_price: number | null;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

interface FillRow {
  id: string;
  order_id: string;
  account_id: string;
  symbol_name: string;
  side: string;
  quantity: number;
  price: number;
  commission: number;
  realized_pnl: number | null;
  created_at: string;
}

interface PositionRow {
  id: string;
  account_id: string;
  symbol_name: string;
  side: string;
  quantity: number;
  entry_price: number;
  opened_at: string;
  take_profit: number | null;
  stop_loss: number | null;
}

interface ClosedPositionRow {
  id: string;
  account_id: string;
  symbol_name: string;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  commission: number;
  swap: number;
  opened_at: string;
  closed_at: string | null;
  is_partial_close: number;
}

interface LedgerRow {
  id: string;
  account_id: string;
  type: string;
  amount: number;
  balance: number;
  description: string | null;
  reference_id: string | null;
  created_at: string;
}

// ── templates ─────────────────────────────────────────────────────────────

export const ACCOUNT_TEMPLATES: Record<string, AccountTemplate> = {
  'demo-standard': {
    id: 'demo-standard',
    name: 'Standard Demo',
    startingBalance: 100_000,
    instrumentType: 'CRYPTO',
    leverage: 10,
    phase: 'DEMO',
  },
  'demo-mini': {
    id: 'demo-mini',
    name: 'Mini Demo',
    startingBalance: 10_000,
    instrumentType: 'CRYPTO',
    leverage: 20,
    phase: 'DEMO',
  },
  'evaluation-pro': {
    id: 'evaluation-pro',
    name: 'Pro Evaluation',
    startingBalance: 25_000,
    instrumentType: 'CRYPTO',
    leverage: 5,
    phase: 'EVALUATION',
  },
};

export const DEFAULT_TEMPLATE_ID = 'demo-standard';

@Injectable()
export class TradingStore {
  constructor(private readonly db: DatabaseService) {}

  // ── accounts ────────────────────────────────────────────────────────────

  createAccount(input: {
    id: string;
    userId: string;
    templateId: string;
    label: string | null;
    balance: number;
    leverage: number;
    phase: string;
    startDate: string;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, user_id, template_id, label, status, balance, phase, leverage, start_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.templateId,
        input.label,
        input.balance,
        input.phase,
        input.leverage,
        input.startDate,
        input.createdAt,
        input.updatedAt,
      );
    this.addLedgerEntry({
      id: 'ledger_' + input.id,
      accountId: input.id,
      type: 'DEPOSIT',
      amount: input.balance,
      balance: input.balance,
      description: `Starting balance (${ACCOUNT_TEMPLATES[input.templateId]?.name ?? input.templateId})`,
      referenceId: null,
      createdAt: input.createdAt,
    });
  }

  getAccountRow(id: string): AccountRow | null {
    return (this.db.prepare<AccountRow>('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow) ?? null;
  }

  listAccountRowsForUser(userId: string): AccountRow[] {
    return this.db
      .prepare<AccountRow>('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as AccountRow[];
  }

  updateBalance(accountId: string, balance: number, updatedAt: string): void {
    this.db
      .prepare('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?')
      .run(balance, updatedAt, accountId);
  }

  // ── orders ──────────────────────────────────────────────────────────────

  insertOrder(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders (id, account_id, symbol_name, side, type, quantity, price, stop_price, take_profit, stop_loss, status, filled_quantity, avg_fill_price, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.id,
        order.accountId,
        order.symbolName,
        order.side,
        order.type,
        order.quantity,
        order.price,
        order.stopPrice,
        order.takeProfit,
        order.stopLoss,
        order.status,
        order.filledQuantity,
        order.avgFillPrice,
        order.comment,
        order.createdAt,
        order.updatedAt,
      );
  }

  updateOrderStatus(
    id: string,
    status: OrderStatus,
    filledQuantity: number,
    avgFillPrice: number | null,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        'UPDATE orders SET status = ?, filled_quantity = ?, avg_fill_price = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, filledQuantity, avgFillPrice, updatedAt, id);
  }

  updateOrderProtection(
    id: string,
    takeProfit: number | null,
    stopLoss: number | null,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        'UPDATE orders SET take_profit = ?, stop_loss = ?, updated_at = ? WHERE id = ?',
      )
      .run(takeProfit, stopLoss, updatedAt, id);
  }

  getOrder(id: string): Order | null {
    const row = this.db.prepare<OrderRow>('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    return row ? this.mapOrder(row) : null;
  }

  listOrdersForAccount(
    accountId: string,
    options: { status?: OrderStatus; page: number; pageSize: number },
  ): { orders: Order[]; total: number } {
    const where = options.status
      ? 'WHERE account_id = ? AND status = ?'
      : 'WHERE account_id = ?';
    const params = options.status
      ? [accountId, options.status]
      : [accountId];
    const total = (
      this.db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM orders ${where}`).get(...params) as { c: number }
    ).c;
    const rows = this.db
      .prepare<OrderRow>(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, options.pageSize, (options.page - 1) * options.pageSize) as OrderRow[];
    return { orders: rows.map((row) => this.mapOrder(row)), total };
  }

  listOpenOrders(): Order[] {
    const rows = this.db
      .prepare<OrderRow>("SELECT * FROM orders WHERE status = 'OPEN'")
      .all() as OrderRow[];
    return rows.map((row) => this.mapOrder(row));
  }

  listOpenOrdersForAccount(accountId: string): Order[] {
    const rows = this.db
      .prepare<OrderRow>("SELECT * FROM orders WHERE account_id = ? AND status = 'OPEN' ORDER BY created_at ASC")
      .all(accountId) as OrderRow[];
    return rows.map((row) => this.mapOrder(row));
  }

  // ── fills ───────────────────────────────────────────────────────────────

  insertFill(fill: Fill): void {
    this.db
      .prepare(
        `INSERT INTO fills (id, order_id, account_id, symbol_name, side, quantity, price, commission, realized_pnl, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fill.id,
        fill.orderId,
        fill.accountId,
        fill.symbolName,
        fill.side,
        fill.quantity,
        fill.price,
        fill.commission,
        fill.realizedPnl,
        fill.createdAt,
      );
  }

  listFillsForAccount(accountId: string, page: number, pageSize: number): { fills: Fill[]; total: number } {
    const total = (
      this.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM fills WHERE account_id = ?').get(accountId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare<FillRow>('SELECT * FROM fills WHERE account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(accountId, pageSize, (page - 1) * pageSize) as FillRow[];
    return { fills: rows.map((row) => this.mapFill(row)), total };
  }

  // ── positions ───────────────────────────────────────────────────────────

  upsertPosition(position: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions (id, account_id, symbol_name, side, quantity, entry_price, opened_at, take_profit, stop_loss)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, symbol_name) DO UPDATE SET
           side = excluded.side,
           quantity = excluded.quantity,
           entry_price = excluded.entry_price,
           take_profit = excluded.take_profit,
           stop_loss = excluded.stop_loss`,
      )
      .run(
        position.id,
        position.accountId,
        position.symbolName,
        position.side,
        position.quantity,
        position.entryPrice,
        position.openedAt,
        position.takeProfit,
        position.stopLoss,
      );
  }

  getPositionByAccountSymbol(accountId: string, symbol: string): Position | null {
    const row = this.db
      .prepare<PositionRow>('SELECT * FROM positions WHERE account_id = ? AND symbol_name = ?')
      .get(accountId, symbol) as PositionRow | undefined;
    return row ? this.mapPosition(row) : null;
  }

  getPosition(id: string): Position | null {
    const row = this.db.prepare<PositionRow>('SELECT * FROM positions WHERE id = ?').get(id) as
      | PositionRow
      | undefined;
    return row ? this.mapPosition(row) : null;
  }

  listPositionsForAccount(accountId: string): Position[] {
    const rows = this.db
      .prepare<PositionRow>('SELECT * FROM positions WHERE account_id = ?')
      .all(accountId) as PositionRow[];
    return rows.map((row) => this.mapPosition(row));
  }

  listAllPositions(): Position[] {
    const rows = this.db.prepare<PositionRow>('SELECT * FROM positions').all() as PositionRow[];
    return rows.map((row) => this.mapPosition(row));
  }

  listPositionsForSymbol(symbol: string): Position[] {
    const rows = this.db
      .prepare<PositionRow>('SELECT * FROM positions WHERE symbol_name = ?')
      .all(symbol) as PositionRow[];
    return rows.map((row) => this.mapPosition(row));
  }

  updatePositionProtection(
    id: string,
    takeProfit: number | null,
    stopLoss: number | null,
  ): void {
    this.db
      .prepare('UPDATE positions SET take_profit = ?, stop_loss = ? WHERE id = ?')
      .run(takeProfit, stopLoss, id);
  }

  deletePosition(id: string): void {
    this.db.prepare('DELETE FROM positions WHERE id = ?').run(id);
  }

  // ── closed positions ────────────────────────────────────────────────────

  insertClosedPosition(closed: ClosedPosition): void {
    this.db
      .prepare(
        `INSERT INTO closed_positions (id, account_id, symbol_name, side, quantity, entry_price, exit_price, realized_pnl, commission, swap, opened_at, closed_at, is_partial_close)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        closed.id,
        closed.accountId,
        closed.symbolName,
        closed.side,
        closed.quantity,
        closed.entryPrice,
        closed.exitPrice,
        closed.realizedPnl,
        closed.commission,
        closed.swap,
        closed.openedAt,
        closed.closedAt,
        closed.isPartialClose ? 1 : 0,
      );
  }

  listClosedPositionsForAccount(accountId: string): ClosedPosition[] {
    const rows = this.db
      .prepare<ClosedPositionRow>('SELECT * FROM closed_positions WHERE account_id = ? ORDER BY closed_at DESC')
      .all(accountId) as ClosedPositionRow[];
    return rows.map((row) => this.mapClosedPosition(row));
  }

  // ── ledger ──────────────────────────────────────────────────────────────

  addLedgerEntry(entry: LedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO ledger_entries (id, account_id, type, amount, balance, description, reference_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.accountId,
        entry.type,
        entry.amount,
        entry.balance,
        entry.description,
        entry.referenceId,
        entry.createdAt,
      );
  }

  listLedgerForAccount(accountId: string, page: number, pageSize: number): { entries: LedgerEntry[]; total: number } {
    const total = (
      this.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM ledger_entries WHERE account_id = ?').get(accountId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare<LedgerRow>(
        'SELECT * FROM ledger_entries WHERE account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(accountId, pageSize, (page - 1) * pageSize) as LedgerRow[];
    return { entries: rows.map((row) => this.mapLedger(row)), total };
  }

  // ── equity points ───────────────────────────────────────────────────────

  insertEquityPoint(accountId: string, equity: number, balance: number, timestamp: string): void {
    this.db
      .prepare('INSERT INTO equity_points (id, account_id, equity, balance, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run('eq_' + Math.random().toString(36).slice(2, 12), accountId, equity, balance, timestamp);
  }

  listEquityPoints(accountId: string, fromMs?: number, toMs?: number): Array<{ equity: number; balance: number; timestamp: string }> {
    let sql = 'SELECT equity, balance, timestamp FROM equity_points WHERE account_id = ?';
    const params: unknown[] = [accountId];
    if (fromMs !== undefined) {
      sql += ' AND timestamp >= ?';
      params.push(new Date(fromMs).toISOString());
    }
    if (toMs !== undefined) {
      sql += ' AND timestamp <= ?';
      params.push(new Date(toMs).toISOString());
    }
    sql += ' ORDER BY timestamp ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{
      equity: number;
      balance: number;
      timestamp: string;
    }>;
    return rows;
  }

  listAccountIdsWithPositions(): string[] {
    const rows = this.db.prepare<{ account_id: string }>('SELECT DISTINCT account_id FROM positions').all() as Array<{
      account_id: string;
    }>;
    return rows.map((row) => row.account_id);
  }

  getAccountOwner(accountId: string): string | null {
    const row = this.db
      .prepare('SELECT user_id FROM accounts WHERE id = ?')
      .get(accountId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  // ── mapping ─────────────────────────────────────────────────────────────

  mapAccount(row: AccountRow): Account {
    const template = ACCOUNT_TEMPLATES[row.template_id];
    return {
      id: row.id,
      userId: row.user_id,
      templateId: row.template_id,
      label: row.label,
      status: row.status as Account['status'],
      balance: row.balance,
      equity: row.balance,
      margin: 0,
      freeMargin: row.balance,
      phase: row.phase,
      startDate: row.start_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      leverage: row.leverage,
      template: template
        ? {
            name: template.name,
            startingBalance: template.startingBalance,
            instrumentType: template.instrumentType,
          }
        : undefined,
    };
  }

  private mapOrder(row: OrderRow): Order {
    return {
      id: row.id,
      accountId: row.account_id,
      symbolName: row.symbol_name,
      side: row.side as OrderSide,
      type: row.type as OrderType,
      quantity: row.quantity,
      price: row.price,
      stopPrice: row.stop_price,
      takeProfit: row.take_profit,
      stopLoss: row.stop_loss,
      status: row.status as OrderStatus,
      filledQuantity: row.filled_quantity,
      avgFillPrice: row.avg_fill_price,
      comment: row.comment,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapFill(row: FillRow): Fill {
    return {
      id: row.id,
      orderId: row.order_id,
      accountId: row.account_id,
      symbolName: row.symbol_name,
      side: row.side as OrderSide,
      quantity: row.quantity,
      price: row.price,
      commission: row.commission,
      realizedPnl: row.realized_pnl,
      createdAt: row.created_at,
    };
  }

  private mapPosition(row: PositionRow): Position {
    return {
      id: row.id,
      accountId: row.account_id,
      symbolName: row.symbol_name,
      side: row.side as PositionSide,
      quantity: row.quantity,
      entryPrice: row.entry_price,
      currentPrice: row.entry_price,
      unrealizedPnl: 0,
      margin: 0,
      contractSize: 1,
      openedAt: row.opened_at,
      takeProfit: row.take_profit,
      stopLoss: row.stop_loss,
    };
  }

  private mapClosedPosition(row: ClosedPositionRow): ClosedPosition {
    return {
      id: row.id,
      accountId: row.account_id,
      symbolName: row.symbol_name,
      side: row.side as PositionSide,
      quantity: row.quantity,
      entryPrice: row.entry_price,
      exitPrice: row.exit_price,
      realizedPnl: row.realized_pnl,
      commission: row.commission,
      swap: row.swap,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      isPartialClose: row.is_partial_close === 1,
    };
  }

  private mapLedger(row: LedgerRow): LedgerEntry {
    return {
      id: row.id,
      accountId: row.account_id,
      type: row.type as LedgerEntry['type'],
      amount: row.amount,
      balance: row.balance,
      description: row.description,
      referenceId: row.reference_id,
      createdAt: row.created_at,
    };
  }
}
