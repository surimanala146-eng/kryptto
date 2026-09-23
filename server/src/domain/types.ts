/**
 * Core domain types shared across modules. These deliberately mirror the
 * schemas a terminal frontend expects (see docs/RESEARCH.md — modeled on the
 * OpenCharts data contract: User, Account, Order, Position, Fill, …).
 */

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export const TIMEFRAMES: readonly Timeframe[] = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
  '1w',
] as const;

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

// ── Market data ───────────────────────────────────────────────────────────

export interface SymbolInfo {
  /** Canonical symbol name used in orders/positions, e.g. "BTCUSDT". */
  name: string;
  displayName: string;
  category: string;
  base: string;
  quote: string;
  contractSize: number;
  tickSize: number;
  tickValue: number;
  minQuantity: number;
  digits: number;
  marginPercent: number;
  maxLeverage: number;
  /** Taker commission as a fraction of notional (0.0005 = 5 bps). */
  commission: number;
  swapLong: number;
  swapShort: number;
  tradingHoursStart: string | null;
  tradingHoursEnd: string | null;
  isActive: boolean;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

export interface Candle {
  /** Bar open time, epoch milliseconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** false while the bar is still forming. */
  closed: boolean;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface TradeEvent {
  id: string;
  symbol: string;
  price: number;
  quantity: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

export interface TickerStats {
  symbol: string;
  lastPrice: number;
  priceChange: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

// ── Users / auth ──────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roles: string[];
  status: string;
  createdAt: string;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
}

// ── Trading ───────────────────────────────────────────────────────────────

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface Order {
  id: string;
  accountId: string;
  symbolName: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number | null;
  stopPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  status: OrderStatus;
  filledQuantity: number;
  avgFillPrice: number | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Fill {
  id: string;
  orderId: string;
  accountId: string;
  symbolName: string;
  side: OrderSide;
  quantity: number;
  price: number;
  commission: number;
  realizedPnl: number | null;
  createdAt: string;
}

export type PositionSide = 'LONG' | 'SHORT';

export interface Position {
  id: string;
  accountId: string;
  symbolName: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  margin: number;
  contractSize: number;
  openedAt: string;
  takeProfit: number | null;
  stopLoss: number | null;
}

export interface ClosedPosition {
  id: string;
  accountId: string;
  symbolName: string;
  side: PositionSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  commission: number;
  swap: number;
  openedAt: string;
  closedAt: string | null;
  isPartialClose: boolean;
}

export type AccountStatus = 'ACTIVE' | 'SUSPENDED';

export interface AccountTemplate {
  id: string;
  name: string;
  startingBalance: number;
  instrumentType: 'CRYPTO';
  leverage: number;
  phase: string;
}

export interface Account {
  id: string;
  userId: string;
  templateId: string;
  label: string | null;
  status: AccountStatus;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  phase: string;
  startDate: string;
  createdAt: string;
  updatedAt: string;
  leverage: number;
  template?: {
    name: string;
    startingBalance: number;
    instrumentType: 'CRYPTO';
  };
}

export type LedgerEntryType = 'DEPOSIT' | 'COMMISSION' | 'REALIZED_PNL' | 'ADJUSTMENT';

export interface LedgerEntry {
  id: string;
  accountId: string;
  type: LedgerEntryType;
  amount: number;
  balance: number;
  description: string | null;
  referenceId: string | null;
  createdAt: string;
}

export interface EquityPoint {
  equity: number;
  balance: number;
  timestamp: string;
}

export interface AccountStats {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  expectancy: number | null;
}
