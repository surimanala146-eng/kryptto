import { Injectable } from '@nestjs/common';
import type { AccountStats } from '../domain/types';
import { AccountsService } from './accounts.service';
import { TradingStore } from './trading.store';

/**
 * Performance statistics for a paper account, computed from closed positions
 * and the equity curve.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly store: TradingStore,
    private readonly accounts: AccountsService,
  ) {}

  compute(userId: string, accountId: string): AccountStats {
    this.accounts.getAccount(userId, accountId);
    const closed = this.store.listClosedPositionsForAccount(accountId);
    const pnls = closed.map((position) => position.realizedPnl);

    const totalTrades = pnls.length;
    const wins = pnls.filter((pnl) => pnl > 0);
    const losses = pnls.filter((pnl) => pnl < 0);
    const sumWins = wins.reduce((sum, pnl) => sum + pnl, 0);
    const sumLosses = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));

    const avgWin = wins.length > 0 ? sumWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? sumLosses / losses.length : 0;
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const profitFactor = sumLosses === 0 ? (sumWins > 0 ? 99.99 : 0) : sumWins / sumLosses;
    const expectancy = totalTrades > 0 ? pnls.reduce((sum, pnl) => sum + pnl, 0) / totalTrades : null;

    const equity = this.store
      .listEquityPoints(accountId)
      .map((point) => point.equity);

    return {
      totalTrades,
      winRate: round(winRate, 2),
      avgWin: round(avgWin, 2),
      avgLoss: round(avgLoss, 2),
      profitFactor: round(profitFactor, 2),
      bestTrade: pnls.length > 0 ? round(Math.max(...pnls), 2) : 0,
      worstTrade: pnls.length > 0 ? round(Math.min(...pnls), 2) : 0,
      sharpeRatio: this.sharpe(equity),
      maxDrawdown: this.maxDrawdown(equity),
      expectancy: expectancy !== null ? round(expectancy, 2) : null,
    };
  }

  /** Max peak-to-trough drawdown of the equity curve, in percent. */
  private maxDrawdown(equity: number[]): number | null {
    if (equity.length < 2) return null;
    let peak = equity[0];
    let maxDd = 0;
    for (const value of equity) {
      if (value > peak) peak = value;
      if (peak > 0) {
        const dd = ((peak - value) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
      }
    }
    return round(maxDd, 2);
  }

  /** Simplified Sharpe ratio from consecutive equity returns (risk-free 0). */
  private sharpe(equity: number[]): number | null {
    if (equity.length < 3) return null;
    const returns: number[] = [];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i - 1] > 0) returns.push(equity[i] / equity[i - 1] - 1);
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    // Equity points are irregular; ~hourly cadence is a fair annualization guess.
    return round((mean / std) * Math.sqrt(24 * 365), 2);
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
