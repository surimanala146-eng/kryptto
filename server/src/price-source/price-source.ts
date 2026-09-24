import type {
  Candle,
  OrderBookSnapshot,
  SymbolInfo,
  Tick,
  TickerStats,
  Timeframe,
  TradeEvent,
} from '../domain/types';

export type Unsubscribe = () => void;

/** A request for a source to begin streaming a specific channel. */
export type StreamRequest =
  | { type: 'candles'; symbol: string; timeframe: Timeframe }
  | { type: 'orderbook'; symbol: string }
  | { type: 'trades'; symbol: string };

export interface PriceSourceEvents {
  tick: (tick: Tick) => void;
  candle: (symbol: string, timeframe: Timeframe, candle: Candle) => void;
  orderBook: (book: OrderBookSnapshot) => void;
  trade: (trade: TradeEvent) => void;
  stats: (stats: TickerStats) => void;
}

export type PriceSourceEvent = keyof PriceSourceEvents;

/**
 * Abstraction over "where prices come from". Two implementations:
 *  - BinanceSource   — live public Binance REST + WebSocket feed
 *  - SimulatorSource — self-contained stochastic price engine
 *
 * The registry picks one at runtime (auto / live / simulated) so the whole
 * platform keeps working with zero external connectivity.
 */
export interface PriceSource {
  readonly id: 'binance' | 'simulator';
  start(): Promise<void>;
  stop(): Promise<void>;
  isHealthy(): boolean;
  listSymbols(): Promise<SymbolInfo[]>;
  getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    fromMs?: number,
    toMs?: number,
  ): Promise<Candle[]>;
  /** Express interest in streaming channels; sources may ignore some types. */
  ensureStreams(requests: StreamRequest[]): void;
  /** Epoch ms of the last event received (health signal). */
  lastEventAt(): number;
  on<K extends PriceSourceEvent>(event: K, handler: PriceSourceEvents[K]): Unsubscribe;
}

/** Minimal typed event emitter shared by both sources. */
export class PriceSourceEmitter {
  private readonly handlers = new Map<PriceSourceEvent, Set<Function>>();

  on<K extends PriceSourceEvent>(event: K, handler: PriceSourceEvents[K]): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit<K extends PriceSourceEvent>(
    event: K,
    ...args: Parameters<PriceSourceEvents[K]>
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch {
        // a faulty subscriber must never take down the feed
      }
    }
  }
}
