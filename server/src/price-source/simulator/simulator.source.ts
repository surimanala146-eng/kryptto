import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from '../../common/ids';
import type {
  Candle,
  OrderBookSnapshot,
  SymbolInfo,
  Tick,
  TickerStats,
  Timeframe,
  TradeEvent,
} from '../../domain/types';
import { TIMEFRAME_MS } from '../../domain/types';
import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  PriceSourceEmitter,
  type PriceSource,
  type PriceSourceEvent,
  type PriceSourceEvents,
  type StreamRequest,
} from '../price-source';

/** Deterministic PRNG (mulberry32) so synthetic history is stable per symbol+tf. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Box–Muller standard normal from a uniform PRNG. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface SimSymbol {
  info: SymbolInfo;
  mid: number;
  dayOpen: number;
  high: number;
  low: number;
  volumeBase: number;
  volQuote: number;
  lastDirection: 1 | -1;
  candleInterest: Set<Timeframe>;
  bookInterest: boolean;
  tradeInterest: boolean;
  bars: Map<Timeframe, Candle>;
  rand: () => number;
}

interface SeedSpec {
  symbol: string;
  price: number;
  displayName: string;
}

/**
 * Self-contained stochastic market. Emits ticks, aggregated candles, order
 * books, trades and 24h stats with the exact same shapes as the live Binance
 * feed, so the rest of the platform cannot tell the difference.
 */
@Injectable()
export class SimulatorSource implements PriceSource {
  readonly id = 'simulator' as const;
  private readonly logger = new Logger(SimulatorSource.name);
  private readonly emitter = new PriceSourceEmitter();
  private readonly symbols = new Map<string, SimSymbol>();
  private readonly symbolList: SymbolInfo[] = [];
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastTickAt = 0;
  private healthy = false;
  private readonly tickIntervalMs: number;
  private readonly historyDepth: number;

  // Reference seed prices; the random walk takes it from here.
  private static readonly SEEDS: SeedSpec[] = [
    { symbol: 'BTCUSDT', price: 67450, displayName: 'Bitcoin' },
    { symbol: 'ETHUSDT', price: 3155, displayName: 'Ethereum' },
    { symbol: 'SOLUSDT', price: 151.2, displayName: 'Solana' },
    { symbol: 'BNBUSDT', price: 592, displayName: 'BNB' },
    { symbol: 'XRPUSDT', price: 0.523, displayName: 'XRP' },
    { symbol: 'ADAUSDT', price: 0.451, displayName: 'Cardano' },
    { symbol: 'DOGEUSDT', price: 0.1215, displayName: 'Dogecoin' },
    { symbol: 'AVAXUSDT', price: 27.4, displayName: 'Avalanche' },
    { symbol: 'LINKUSDT', price: 14.6, displayName: 'Chainlink' },
    { symbol: 'DOTUSDT', price: 4.25, displayName: 'Polkadot' },
    { symbol: 'LTCUSDT', price: 72.1, displayName: 'Litecoin' },
    { symbol: 'TRXUSDT', price: 0.118, displayName: 'TRON' },
    { symbol: 'ATOMUSDT', price: 6.52, displayName: 'Cosmos' },
    { symbol: 'NEARUSDT', price: 2.84, displayName: 'NEAR Protocol' },
    { symbol: 'APTUSDT', price: 7.21, displayName: 'Aptos' },
    { symbol: 'ARBUSDT', price: 0.752, displayName: 'Arbitrum' },
    { symbol: 'OPUSDT', price: 1.66, displayName: 'Optimism' },
    { symbol: 'INJUSDT', price: 21.3, displayName: 'Injective' },
    { symbol: 'SUIUSDT', price: 1.42, displayName: 'Sui' },
    { symbol: 'TIAUSDT', price: 5.48, displayName: 'Celestia' },
    { symbol: 'FILUSDT', price: 3.82, displayName: 'Filecoin' },
    { symbol: 'ETCUSDT', price: 22.6, displayName: 'Ethereum Classic' },
    { symbol: 'AAVEUSDT', price: 86.4, displayName: 'Aave' },
    { symbol: 'UNIUSDT', price: 7.85, displayName: 'Uniswap' },
  ];

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.tickIntervalMs = Math.max(100, config.marketData.simulatorTickIntervalMs);
    this.historyDepth = config.marketData.candleHistoryDepth;
  }

  async start(): Promise<void> {
    if (this.healthy) return;
    this.buildUniverse();
    this.startedAt = Date.now();
    this.healthy = true;
    this.timer = setInterval(() => this.tickAll(), this.tickIntervalMs);
    this.tickAll(); // immediate first round so consumers see prices instantly
    this.logger.log(
      `Simulated market started — ${this.symbols.size} symbols, tick every ${this.tickIntervalMs}ms`,
    );
  }

  async stop(): Promise<void> {
    this.healthy = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isHealthy(): boolean {
    return this.healthy && this.lastTickAt > 0;
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return this.symbolList;
  }

  ensureStreams(requests: StreamRequest[]): void {
    for (const request of requests) {
      const symbol = this.symbols.get(request.symbol);
      if (!symbol) continue;
      if (request.type === 'orderbook') symbol.bookInterest = true;
      else if (request.type === 'trades') symbol.tradeInterest = true;
      else symbol.candleInterest.add(request.timeframe);
    }
  }

  on<K extends PriceSourceEvent>(event: K, handler: PriceSourceEvents[K]): () => void {
    return this.emitter.on(event, handler);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private buildUniverse(): void {
    for (const seed of SimulatorSource.SEEDS) {
      const info = this.makeSymbolInfo(seed);
      const rand = mulberry32(fnv1a(`sim:${seed.symbol}`));
      const mid = seed.price;
      const symbol: SimSymbol = {
        info,
        mid,
        dayOpen: mid * (1 + (rand() - 0.5) * 0.04),
        high: mid * (1 + rand() * 0.012),
        low: mid * (1 - rand() * 0.012),
        volumeBase: rand() * 5_000_000,
        volQuote: rand() * 30_000_000,
        lastDirection: 1,
        candleInterest: new Set<Timeframe>(),
        bookInterest: false,
        tradeInterest: false,
        bars: new Map<Timeframe, Candle>(),
        rand,
      };
      this.symbols.set(seed.symbol, symbol);
      this.symbolList.push(info);
    }
  }

  private makeSymbolInfo(seed: SeedSpec): SymbolInfo {
    const price = seed.price;
    let tickSize: number;
    let minQuantity: number;
    if (price >= 1000) {
      tickSize = 0.1;
      minQuantity = 0.00001;
    } else if (price >= 100) {
      tickSize = 0.01;
      minQuantity = 0.001;
    } else if (price >= 1) {
      tickSize = 0.001;
      minQuantity = 0.01;
    } else {
      tickSize = 0.00001;
      minQuantity = 1;
    }
    const digits = Math.max(0, Math.round(-Math.log10(tickSize)));
    return {
      name: seed.symbol,
      displayName: `${seed.displayName} / USDT`,
      category: 'CRYPTO',
      base: seed.symbol.replace(/USDT$/, ''),
      quote: 'USDT',
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
    };
  }

  private tickAll(): void {
    const now = Date.now();
    this.lastTickAt = now;
    for (const symbol of this.symbols.values()) {
      this.tickSymbol(symbol, now);
    }
  }

  private tickSymbol(symbol: SimSymbol, now: number): void {
    const info = symbol.info;

    // Geometric Brownian motion step: ~60% annualized vol, slight drift.
    const dtYears = this.tickIntervalMs / (365 * 24 * 3600 * 1000);
    const sigma = 0.6;
    const mu = 0.05;
    const z = gaussian(symbol.rand);
    const step = Math.exp((mu - (sigma * sigma) / 2) * dtYears + sigma * Math.sqrt(dtYears) * z);
    symbol.mid = Math.max(info.tickSize, symbol.mid * step);
    symbol.lastDirection = z >= 0 ? 1 : -1;

    const spread = Math.max(info.tickSize, symbol.mid * (0.00008 + symbol.rand() * 0.00025));
    const bid = this.roundToTick(symbol.mid - spread / 2, info.tickSize);
    const ask = this.roundToTick(symbol.mid + spread / 2, info.tickSize);
    const last = this.roundToTick(symbol.mid, info.tickSize);

    symbol.high = Math.max(symbol.high, last);
    symbol.low = Math.min(symbol.low, last);
    const tradeQty = Math.exp(-2 + symbol.rand() * 3) * (symbol.mid > 1000 ? 0.35 : 40);
    symbol.volumeBase += tradeQty;
    symbol.volQuote += tradeQty * last;

    this.emitter.emit('tick', { symbol: info.name, bid, ask, last, timestamp: now });

    for (const tf of symbol.candleInterest) {
      const candle = this.aggregateBar(symbol, tf, last, tradeQty, now);
      this.emitter.emit('candle', info.name, tf, candle);
    }

    if (symbol.bookInterest) {
      this.emitter.emit('orderBook', this.buildBook(symbol, bid, ask, now));
    }

    if (symbol.tradeInterest) {
      const trade: TradeEvent = {
        id: ulid(),
        symbol: info.name,
        price: last,
        quantity: Number(tradeQty.toFixed(6)),
        side: symbol.lastDirection >= 0 ? 'BUY' : 'SELL',
        timestamp: now,
      };
      this.emitter.emit('trade', trade);
    }

    this.emitter.emit('stats', {
      symbol: info.name,
      lastPrice: last,
      priceChange: last - symbol.dayOpen,
      priceChangePercent:
        symbol.dayOpen > 0 ? ((last - symbol.dayOpen) / symbol.dayOpen) * 100 : 0,
      highPrice: symbol.high,
      lowPrice: symbol.low,
      volume: Number(symbol.volumeBase.toFixed(4)),
      quoteVolume: Number(symbol.volQuote.toFixed(2)),
    });
  }

  private aggregateBar(
    symbol: SimSymbol,
    tf: Timeframe,
    price: number,
    qty: number,
    now: number,
  ): Candle {
    const tfMs = TIMEFRAME_MS[tf];
    const bucket = Math.floor(now / tfMs) * tfMs;
    const previous = symbol.bars.get(tf);

    if (previous && previous.time !== bucket) {
      // previous bucket finished — emit its final, closed state
      this.emitter.emit('candle', symbol.info.name, tf, { ...previous, closed: true });
    }

    let bar = symbol.bars.get(tf);
    if (!bar || bar.time !== bucket) {
      bar = {
        time: bucket,
        open: previous ? previous.close : price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        closed: false,
      };
      symbol.bars.set(tf, bar);
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += qty;
    return { ...bar };
  }

  private buildBook(symbol: SimSymbol, bid: number, ask: number, now: number): OrderBookSnapshot {
    const info = symbol.info;
    const bids = [];
    const asks = [];
    for (let i = 0; i < 20; i++) {
      const decay = Math.exp(-i / 12);
      const step = info.tickSize * (1 + Math.floor(i / 5));
      bids.push({
        price: this.roundToTick(bid - i * step, info.tickSize),
        quantity: Number((Math.exp(-2 + symbol.rand() * 3) * 60 * (1.2 - decay * 0.7)).toFixed(4)),
      });
      asks.push({
        price: this.roundToTick(ask + i * step, info.tickSize),
        quantity: Number((Math.exp(-2 + symbol.rand() * 3) * 60 * (1.2 - decay * 0.7)).toFixed(4)),
      });
    }
    return { symbol: info.name, bids, asks, timestamp: now };
  }

  private roundToTick(value: number, tickSize: number): number {
    const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
    return Number((Math.round(value / tickSize) * tickSize).toFixed(decimals));
  }

  async getCandles(
    symbolName: string,
    timeframe: Timeframe,
    limit: number,
    fromMs?: number,
    _toMs?: number,
  ): Promise<Candle[]> {
    const symbol = this.symbols.get(symbolName);
    if (!symbol) {
      throw new Error(`Unknown symbol ${symbolName}`);
    }
    const tfMs = TIMEFRAME_MS[timeframe];
    const nowBucket = Math.floor(Date.now() / tfMs) * tfMs;
    const depth = Math.min(Math.max(limit, 2), this.historyDepth);

    // Deterministic backward walk from the current mid price.
    const rand = mulberry32(fnv1a(`hist:${symbolName}:${timeframe}`));
    const closes: number[] = [symbol.mid];
    const barVol = 0.02 * Math.sqrt(tfMs / TIMEFRAME_MS['1h']);
    for (let i = 1; i < depth; i++) {
      closes.push(Math.max(symbol.info.tickSize, closes[i - 1] / Math.exp(gaussian(rand) * barVol)));
    }

    const candles: Candle[] = [];
    for (let i = depth - 1; i >= 0; i--) {
      const time = nowBucket - i * tfMs;
      // i = bars ago; closes[0] is the current mid, closes[depth-1] the oldest
      const close = closes[i];
      const open =
        candles.length === 0
          ? close / (1 + (gaussian(rand) * barVol) / 4)
          : candles[candles.length - 1].close;
      const wick = Math.abs(gaussian(rand)) * barVol * 0.6;
      candles.push({
        time,
        open: this.roundToTick(open, symbol.info.tickSize),
        high: this.roundToTick(Math.max(open, close) * (1 + wick / 2), symbol.info.tickSize),
        low: this.roundToTick(Math.min(open, close) * (1 - wick / 2), symbol.info.tickSize),
        close: this.roundToTick(close, symbol.info.tickSize),
        volume: Number((Math.exp(4 + rand() * 3) * (symbol.mid > 1000 ? 1 : 120)).toFixed(4)),
        closed: time !== nowBucket,
      });
    }

    // Seed/replace the current bucket with the live aggregated bar when present
    // (and start aggregating this timeframe from now on).
    const live = symbol.bars.get(timeframe);
    if (live && live.time === nowBucket) {
      candles[candles.length - 1] = { ...live };
    } else if (!live) {
      symbol.candleInterest.add(timeframe);
      symbol.bars.set(timeframe, candles[candles.length - 1]);
    }
    void fromMs;
    return candles;
  }

  get startedAtMs(): number {
    return this.startedAt;
  }

  lastEventAt(): number {
    return this.lastTickAt;
  }
}
