import { Inject, Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { CONFIG, type AppConfig } from '../../config/configuration';
import type {
  Candle,
  OrderBookSnapshot,
  SymbolInfo,
  Tick,
  TickerStats,
  Timeframe,
  TradeEvent,
} from '../../domain/types';
import {
  PriceSourceEmitter,
  type PriceSource,
  type PriceSourceEvent,
  type PriceSourceEvents,
  type StreamRequest,
} from '../price-source';

interface BinanceSymbolRow {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: Array<Record<string, string>>;
}

interface BinanceKlineRow {
  [index: number]: number | string;
}

interface BinanceBookTickerMsg {
  stream: string;
  data: { s: string; b: string; B?: number; a: string; A?: number; T?: number; E?: number };
}

interface BinanceKlineMsg {
  stream: string;
  data: {
    s: string;
    E: number;
    k: { t: number; T: number; o: string; h: string; l: string; c: string; v: string; x: boolean; i: string };
  };
}

interface BinanceDepthMsg {
  stream: string;
  data: {
    s: string;
    E: number;
    bids: [string, string][];
    asks: [string, string][];
  };
}

interface BinanceAggTradeMsg {
  stream: string;
  data: { s: string; a: number; p: string; q: string; m: boolean; T: number };
}

interface BinanceAllTickerMsg {
  stream: string;
  data: Array<{
    s: string;
    c: string;
    P: string;
    p: string;
    h: string;
    l: string;
    v: string;
    q: string;
  }>;
}

function streamName(symbol: string, tf: Timeframe): string {
  return `${symbol.toLowerCase()}@kline_${tf}`;
}

function bookStream(symbol: string): string {
  return `${symbol.toLowerCase()}@depth20@100ms`;
}

function tradesStream(symbol: string): string {
  return `${symbol.toLowerCase()}@aggTrade`;
}

function tickerStream(symbol: string): string {
  return `${symbol.toLowerCase()}@bookTicker`;
}

/**
 * Live market data from Binance's public REST + WebSocket APIs (no API key
 * required for market data). A single combined-stream connection carries
 * bookTickers for the whole universe; klines / depth / trades streams are
 * subscribed on demand based on client interest.
 */
@Injectable()
export class BinanceSource implements PriceSource {
  readonly id = 'binance' as const;
  private readonly logger = new Logger(BinanceSource.name);
  private readonly emitter = new PriceSourceEmitter();
  private readonly symbols = new Map<string, SymbolInfo>();

  private ws: WebSocket | null = null;
  private wsHealthy = false;
  private lastMessageAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  /** Streams currently subscribed on the combined connection. */
  private readonly activeStreams = new Set<string>();
  /** Interest computed from ensureStreams() calls (refcounted upstream). */
  private readonly candleStreams = new Set<string>();
  private readonly bookStreams = new Set<string>();
  private readonly tradeStreams = new Set<string>();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private get restBase(): string {
    return this.config.marketData.binanceRestUrl.replace(/\/$/, '');
  }

  async start(): Promise<void> {
    this.stopped = false;
    // REST bootstrap first — fails fast (and hard) if Binance is unreachable,
    // which is exactly what the auto-fallback registry relies on.
    await this.bootstrapSymbols();
    this.connect();
    this.logger.log(`Binance live source started — ${this.symbols.size} symbols`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wsHealthy = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, 'shutdown');
    this.ws = null;
  }

  isHealthy(): boolean {
    return (
      !this.stopped &&
      this.wsHealthy &&
      this.lastMessageAt > 0 &&
      Date.now() - this.lastMessageAt < 15_000
    );
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    if (this.symbols.size === 0) {
      await this.bootstrapSymbols();
    }
    return [...this.symbols.values()];
  }

  ensureStreams(requests: StreamRequest[]): void {
    const desired = new Set<string>();
    for (const request of requests) {
      if (request.type === 'candles') desired.add(streamName(request.symbol, request.timeframe));
      else if (request.type === 'orderbook') desired.add(bookStream(request.symbol));
      else desired.add(tradesStream(request.symbol));
    }
    this.candleStreams.clear();
    this.bookStreams.clear();
    this.tradeStreams.clear();
    for (const stream of desired) {
      if (stream.includes('@kline_')) this.candleStreams.add(stream);
      else if (stream.includes('@depth')) this.bookStreams.add(stream);
      else this.tradeStreams.add(stream);
    }
    this.syncSubscriptions();
  }

  on<K extends PriceSourceEvent>(event: K, handler: PriceSourceEvents[K]): () => void {
    return this.emitter.on(event, handler);
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    fromMs?: number,
    toMs?: number,
  ): Promise<Candle[]> {
    const params = new URLSearchParams({
      symbol,
      interval: timeframe,
      limit: String(Math.min(Math.max(limit, 1), 1000)),
    });
    if (fromMs) params.set('startTime', String(fromMs));
    if (toMs) params.set('endTime', String(toMs));

    const rows = await this.rest<BinanceKlineRow[]>(
      `/api/v3/klines?${params.toString()}`,
    );
    return rows.map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closed: true,
    }));
  }

  // ── REST bootstrap ──────────────────────────────────────────────────────

  private async bootstrapSymbols(): Promise<void> {
    const [exchangeInfo, tickers] = await Promise.all([
      this.rest<{ symbols: BinanceSymbolRow[] }>('/api/v3/exchangeInfo'),
      this.rest<Array<{ symbol: string; quoteVolume: string }>>('/api/v3/ticker/24hr'),
    ]);

    const volumeBySymbol = new Map<string, number>();
    for (const ticker of tickers) {
      volumeBySymbol.set(ticker.symbol, Number(ticker.quoteVolume));
    }

    const candidates = exchangeInfo.symbols
      .filter(
        (row) =>
          row.status === 'TRADING' &&
          row.quoteAsset === 'USDT' &&
          !/(UP|DOWN|BULL|BEAR)$/.test(row.symbol),
      )
      .sort(
        (a, b) => (volumeBySymbol.get(b.symbol) ?? 0) - (volumeBySymbol.get(a.symbol) ?? 0),
      )
      .slice(0, this.config.marketData.maxSymbols);

    this.symbols.clear();
    for (const row of candidates) {
      const priceFilter = row.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const lotFilter = row.filters.find((f) => f.filterType === 'LOT_SIZE');
      const tickSize = Number(priceFilter?.tickSize ?? '0.001') || 0.001;
      const minQuantity = Number(lotFilter?.minQty ?? '0.001') || 0.001;
      const digits = Math.max(0, Math.round(-Math.log10(tickSize)));
      this.symbols.set(row.symbol, {
        name: row.symbol,
        displayName: `${row.baseAsset} / ${row.quoteAsset}`,
        category: 'CRYPTO',
        base: row.baseAsset,
        quote: row.quoteAsset,
        contractSize: 1,
        tickSize,
        tickValue: tickSize,
        minQuantity,
        digits,
        marginPercent: 10,
        maxLeverage: 10,
        commission: 0.0005,
        swapLong: 0,
        swapShort: 0,
        tradingHoursStart: null,
        tradingHoursEnd: null,
        isActive: true,
      });
    }
    if (this.symbols.size === 0) {
      throw new Error('Binance returned no tradable USDT pairs');
    }
  }

  private async rest<T>(path: string, timeoutMs = 10_000): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Binance REST ${path} failed: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  // ── WebSocket combined stream ───────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;

    const baseStreams = [...this.symbols.keys()].map(tickerStream);
    // Combined-stream URLs have a length cap; chunk if the universe is huge.
    const chunkSize = 180;
    const streamsParam = baseStreams.slice(0, chunkSize).join('/');
    const url = `${this.config.marketData.binanceWsUrl}?streams=${streamsParam}`;

    const socket = new WebSocket(url);
    this.ws = socket;

    socket.on('open', () => {
      this.wsHealthy = true;
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.activeStreams.clear();
      for (const stream of baseStreams.slice(0, chunkSize)) this.activeStreams.add(stream);
      this.syncSubscriptions();
      this.logger.log('Binance WebSocket connected');
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      try {
        this.handleMessage(raw.toString());
      } catch {
        // ignore malformed frames
      }
    });

    socket.on('error', (error: Error) => {
      this.logger.warn(`Binance WebSocket error: ${error.message}`);
    });

    socket.on('close', () => {
      this.wsHealthy = false;
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
      this.reconnectAttempts += 1;
      this.logger.warn(
        `Binance WebSocket closed — reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private syncSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const desired = new Set<string>([
      ...this.activeStreams,
      ...this.candleStreams,
      ...this.bookStreams,
      ...this.tradeStreams,
    ]);

    const toSubscribe: string[] = [];
    for (const stream of desired) {
      if (!this.activeStreams.has(stream)) toSubscribe.push(stream);
    }
    const toUnsubscribe: string[] = [];
    for (const stream of this.activeStreams) {
      if (
        !desired.has(stream) &&
        !this.candleStreams.has(stream) &&
        !this.bookStreams.has(stream) &&
        !this.tradeStreams.has(stream)
      ) {
        toUnsubscribe.push(stream);
      }
    }

    if (toSubscribe.length > 0) {
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toSubscribe, id: Date.now() }));
      for (const stream of toSubscribe) this.activeStreams.add(stream);
    }
    if (toUnsubscribe.length > 0) {
      this.ws.send(
        JSON.stringify({ method: 'UNSUBSCRIBE', params: toUnsubscribe, id: Date.now() }),
      );
      for (const stream of toUnsubscribe) this.activeStreams.delete(stream);
    }
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as { stream?: string; data?: unknown } & Record<string, unknown>;

    // Control-frame acknowledgements ({result: null}) — ignore.
    if (!message.stream || !message.data) return;

    const stream: string = message.stream;

    if (stream.includes('@kline_')) {
      const msg = message as unknown as BinanceKlineMsg;
      const k = msg.data.k;
      const tf = k.i as Timeframe;
      const candle: Candle = {
        time: k.t,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        closed: k.x,
      };
      this.emitter.emit('candle', msg.data.s, tf, candle);
      return;
    }

    if (stream.endsWith('@bookTicker')) {
      const msg = message as unknown as BinanceBookTickerMsg;
      const bid = Number(msg.data.b);
      const ask = Number(msg.data.a);
      this.emitter.emit('tick', {
        symbol: msg.data.s,
        bid,
        ask,
        last: (bid + ask) / 2,
        timestamp: msg.data.T ?? msg.data.E ?? Date.now(),
      });
      return;
    }

    if (stream.includes('@depth')) {
      const msg = message as unknown as BinanceDepthMsg;
      const book: OrderBookSnapshot = {
        symbol: msg.data.s,
        bids: msg.data.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        asks: msg.data.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
        timestamp: msg.data.E,
      };
      this.emitter.emit('orderBook', book);
      return;
    }

    if (stream.endsWith('@aggTrade')) {
      const msg = message as unknown as BinanceAggTradeMsg;
      const trade: TradeEvent = {
        id: String(msg.data.a),
        symbol: msg.data.s,
        price: Number(msg.data.p),
        quantity: Number(msg.data.q),
        side: msg.data.m ? 'SELL' : 'BUY', // m=true → buyer is market maker → aggressor sold
        timestamp: msg.data.T,
      };
      this.emitter.emit('trade', trade);
      return;
    }

    if (stream === '!ticker@arr') {
      const msg = message as unknown as BinanceAllTickerMsg;
      for (const row of msg.data) {
        if (!this.symbols.has(row.s)) continue;
        const stats: TickerStats = {
          symbol: row.s,
          lastPrice: Number(row.c),
          priceChange: Number(row.p),
          priceChangePercent: Number(row.P),
          highPrice: Number(row.h),
          lowPrice: Number(row.l),
          volume: Number(row.v),
          quoteVolume: Number(row.q),
        };
        this.emitter.emit('stats', stats);
      }
      return;
    }
  }

  lastEventAt(): number {
    return this.lastMessageAt;
  }
}
