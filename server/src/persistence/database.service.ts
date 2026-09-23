import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG, type AppConfig } from '../config/configuration';

/**
 * Thin wrapper around node:sqlite (built into Node ≥ 22.5 — zero native deps).
 * Synchronous by design: paper-trading write volumes are tiny and the
 * matching engine needs strict ordering.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly db: DatabaseSync;

  constructor(@Inject(CONFIG) config: AppConfig) {
    const target = config.databasePath;
    if (target !== ':memory:') {
      mkdirSync(resolve(dirname(target)), { recursive: true });
    }
    this.db = new DatabaseSync(target);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    if (target !== ':memory:') {
      this.logger.log(`SQLite database ready at ${resolve(target)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        roles TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        balance REAL NOT NULL,
        phase TEXT NOT NULL DEFAULT 'DEMO',
        leverage INTEGER NOT NULL DEFAULT 10,
        start_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL,
        stop_price REAL,
        take_profit REAL,
        stop_loss REAL,
        status TEXT NOT NULL,
        filled_quantity REAL NOT NULL DEFAULT 0,
        avg_fill_price REAL,
        comment TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(status, symbol_name);

      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        commission REAL NOT NULL,
        realized_pnl REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fills_account ON fills(account_id, created_at);

      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        entry_price REAL NOT NULL,
        opened_at TEXT NOT NULL,
        take_profit REAL,
        stop_loss REAL,
        UNIQUE (account_id, symbol_name)
      );
      CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(account_id);

      CREATE TABLE IF NOT EXISTS closed_positions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        commission REAL NOT NULL DEFAULT 0,
        swap REAL NOT NULL DEFAULT 0,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        is_partial_close INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_closed_positions_account ON closed_positions(account_id, closed_at);

      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance REAL NOT NULL,
        description TEXT,
        reference_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, created_at);

      CREATE TABLE IF NOT EXISTS equity_points (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        equity REAL NOT NULL,
        balance REAL NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equity_account ON equity_points(account_id, timestamp);
    `);
  }

  prepare<Row = Record<string, unknown>>(sql: string): {
    run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
    all: (...params: unknown[]) => Row[];
    get: (...params: unknown[]) => Row | undefined;
  } {
    return this.db.prepare(sql) as never;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
