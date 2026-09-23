import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  Candle,
  OrderBookSnapshot,
  SymbolInfo,
  Tick,
  TickerStats,
  Timeframe,
  TradeEvent,
} from '../domain/types';
import { PriceSourceRegistry, type PriceSourceStatus } from '../price-source/price-source.registry';
import type { StreamRequest } from '../price-source/price-source';
import { CandlesService } from './candles.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ApiError } from '../common/api-error';

const RECENT_TRADES_PER_SYMBOL = 60;
const STATUS_POLL_MS = 5_000;

/**
 * Facade over the active price source: symbol registry, live tick/stats/book
 * caches, candle history, and interest-driven stream fan-out to the realtime
 * hub. Everything under /api/market-data flows through here.
 */
@Injectable()
export class MarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataService.name);
  private readonly ticks = new Map<string, Tick>();
  private readonly stats = new Map<string, TickerStats>();
  private readonly books = new Map<string, OrderBookSnapshot>();
  private readonly recentTrades = new Map<string, TradeEvent[]>();
  private symbols: SymbolInfo[] = [];
  private readonly symbolsByName = new Map<string, SymbolInfo>();
  private started = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastPublishedStatus: string | null = null;
  private readonly stopSourceListeners: Array<() => void> = [];

  constructor(
    private readonly registry: PriceSourceRegistry,
    private readonly candles: CandlesService,
    private readonly realtime: RealtimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Kick off source selection in the background so the HTTP layer can boot
    // even while (or if) the upstream is slow/unreachable — /api/status will
    // report the intermediate state.
    void this.bootstrap().catch((error) => {
      this.logger.error(`Market data bootstrap failed: ${(error as Error).message}`);
    });

    this.realtime.onInterestChange((channels) => this.onInterestChange(channels));

    this.statusTimer = setInterval(() => this.publishStatusIfChanged(), STATUS_POLL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    for (const stop of this.stopSourceListeners) stop();
    this.stopSourceListeners.length = 0;
  }

  private async bootstrap(): Promise<void> {
    await this.registry.start();
    this.symbols = await this.registry.listSymbols();
    this.symbolsByName.clear();
    for (const symbol of this.symbols) this.symbolsByName.set(symbol.name, symbol);
    this.wireSourceEvents();
    this.started = true;
    this.logger.log(`Market data ready — ${this.symbols.length} symbols`);
    this.publishStatusIfChanged();
  }

  private wireSourceEvents(): void {
    for (const stop of this.stopSourceListeners) stop();
    this.stopSourceListeners.length = 0;
    const source = this.registry.source();

    this.stopSourceListeners.push(
      source.on('tick', (tick) => {
        this.ticks.set(tick.symbol, tick);
        this.realtime.publish('ticks', tick);
        this.realtime.publish(`ticks:${tick.symbol}`, tick);
        for (const handler of this.tickHandlers) {
          try {
            handler(tick);
          } catch {
            // engine errors are logged by the engine itself
          }
        }
      }),
      source.on('candle', (symbol, timeframe, candle) => {
        const updated = this.candles.onCandle(symbol, timeframe, candle);
        this.realtime.publish(`candles:${symbol}:${timeframe}`, updated);
      }),
      source.on('orderBook', (book) => {
        this.books.set(book.symbol, book);
        this.realtime.publish(`orderbook:${book.symbol}`, book);
      }),
      source.on('trade', (trade) => {
        const list = this.recentTrades.get(trade.symbol) ?? [];
        list.push(trade);
        if (list.length > RECENT_TRADES_PER_SYMBOL) list.splice(0, list.length - RECENT_TRADES_PER_SYMBOL);
        this.recentTrades.set(trade.symbol, list);
        this.realtime.publish(`trades:${trade.symbol}`, trade);
      }),
      source.on('stats', (stats) => {
        this.stats.set(stats.symbol, stats);
        this.realtime.publish(`stats:${stats.symbol}`, stats);
      }),
    );
  }

  private onInterestChange(channels: Set<string>): void {
    if (!this.started) return;
    const requests: StreamRequest[] = [];
    for (const channel of channels) {
      if (channel.startsWith('candles:')) {
        const [, symbol, tf] = channel.split(':');
        requests.push({ type: 'candles', symbol, timeframe: tf as Timeframe });
      } else if (channel.startsWith('orderbook:')) {
        requests.push({ type: 'orderbook', symbol: channel.slice('orderbook:'.length) });
      } else if (channel.startsWith('trades:')) {
        requests.push({ type: 'trades', symbol: channel.slice('trades:'.length) });
      }
    }
    if (requests.length > 0) {
      this.registry.ensureStreams(requests);
    }
  }

  private publishStatusIfChanged(): void {
    const status = this.status();
    const fingerprint = JSON.stringify(status);
    if (fingerprint !== this.lastPublishedStatus) {
      this.lastPublishedStatus = fingerprint;
      this.realtime.publish('status', status);
    }
  }

  private ensureReady(): void {
    if (!this.started) {
      throw new ApiError(503, 'MARKET_DATA_STARTING', 'Market data is still starting up');
    }
  }

  // ── public queries (used by the controller, matching engine, preview) ───

  listSymbols(): SymbolInfo[] {
    this.ensureReady();
    return this.symbols;
  }

  getSymbol(name: string): SymbolInfo {
    this.ensureReady();
    const symbol = this.symbolsByName.get(name);
    if (!symbol) {
      throw ApiError.notFound(`Unknown symbol "${name}"`, 'SYMBOL_NOT_FOUND');
    }
    return symbol;
  }

  getTicks(): Record<string, Tick> {
    this.ensureReady();
    return Object.fromEntries(this.ticks);
  }

  getTick(symbol: string): Tick {
    this.getSymbol(symbol);
    const tick = this.ticks.get(symbol);
    if (!tick) {
      throw ApiError.notFound(`No tick yet for "${symbol}"`, 'TICK_NOT_READY');
    }
    return tick;
  }

  getStats(symbol: string): TickerStats {
    this.getSymbol(symbol);
    const stats = this.stats.get(symbol);
    if (!stats) {
      throw ApiError.notFound(`No stats yet for "${symbol}"`, 'STATS_NOT_READY');
    }
    return stats;
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    fromMs?: number,
    toMs?: number,
  ): Promise<Candle[]> {
    this.getSymbol(symbol);
    const candles = await this.candles.getCandles(symbol, timeframe, limit, fromMs, toMs);
    // Register interest so live updates flow even without a WS subscriber.
    this.registry.ensureStreams([{ type: 'candles', symbol, timeframe }]);
    return candles;
  }

  getOrderBook(symbol: string): OrderBookSnapshot {
    this.getSymbol(symbol);
    const book = this.books.get(symbol);
    if (!book) {
      throw ApiError.notFound(
        `Order book for "${symbol}" is not streaming yet — subscribe to the orderbook channel`,
        'ORDERBOOK_NOT_READY',
      );
    }
    return book;
  }

  getRecentTrades(symbol: string): TradeEvent[] {
    this.getSymbol(symbol);
    const trades = this.recentTrades.get(symbol);
    if (!trades || trades.length === 0) {
      this.registry.ensureStreams([{ type: 'trades', symbol }]);
      return [];
    }
    return [...trades].reverse();
  }

  /** Latest bar snapshot for pushing to a newly-subscribed WS client. */
  latestCandle(symbol: string, timeframe: Timeframe): Candle | null {
    return this.candles.latest(symbol, timeframe);
  }

  status(): PriceSourceStatus & { symbols: number } {
    const status = this.registry.status();
    return { ...status, symbols: this.symbols.length };
  }

  /** Tick for the matching engine: never throws, returns null when absent. */
  peekTick(symbol: string): Tick | null {
    return this.ticks.get(symbol) ?? null;
  }

  private readonly tickHandlers = new Set<(tick: Tick) => void>();

  /** Subscribe to the live tick stream (used by the matching engine). */
  onTick(handler: (tick: Tick) => void): () => void {
    this.tickHandlers.add(handler);
    return () => this.tickHandlers.delete(handler);
  }
}
