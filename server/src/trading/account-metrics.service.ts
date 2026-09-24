import { Injectable } from '@nestjs/common';
import type { Account, Position, Tick } from '../domain/types';
import { MarketDataService } from '../market-data/market-data.service';
import { TradingStore } from './trading.store';

/**
 * Computes live account + position metrics (mark price, unrealized P&L,
 * margin, equity, free margin) by combining stored state with the live tick
 * cache. Pure read side — the matching engine owns all mutations.
 */
@Injectable()
export class AccountMetricsService {
  constructor(
    private readonly store: TradingStore,
    private readonly marketData: MarketDataService,
  ) {}

  /** Position view with live mark price, P&L and margin. */
  decoratePosition(position: Position, leverage: number): Position {
    const tick: Tick | null = this.marketData.peekTick(position.symbolName);
    const mark = tick ? (position.side === 'LONG' ? tick.bid : tick.ask) : position.currentPrice;
    const direction = position.side === 'LONG' ? 1 : -1;
    const price = mark > 0 ? mark : position.entryPrice;
    const unrealizedPnl = (price - position.entryPrice) * position.quantity * direction;
    return {
      ...position,
      currentPrice: price,
      unrealizedPnl,
      margin: (position.quantity * price) / leverage,
    };
  }

  decoratePositions(accountId: string, leverage: number): Position[] {
    return this.store
      .listPositionsForAccount(accountId)
      .map((position) => this.decoratePosition(position, leverage));
  }

  /** Account view with equity / used margin / free margin. */
  decorateAccount(accountId: string): Account | null {
    const row = this.store.getAccountRow(accountId);
    if (!row) return null;
    const base = this.store.mapAccount(row);
    if (base.status !== 'ACTIVE') {
      return { ...base, equity: base.balance, margin: 0, freeMargin: 0 };
    }
    const positions = this.decoratePositions(accountId, base.leverage);
    const unrealized = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
    const margin = positions.reduce((sum, position) => sum + position.margin, 0);
    const equity = base.balance + unrealized;
    return { ...base, equity, margin, freeMargin: Math.max(0, equity - margin) };
  }
}
