import { Injectable, Logger } from '@nestjs/common';
import type { Candle, Timeframe } from '../domain/types';
import { PriceSourceRegistry } from '../price-source/price-source.registry';

const MAX_CACHED_BARS = 2000;

/**
 * Candle cache. Closed and forming bars per (symbol, timeframe) are kept in
 * memory, updated from the active price source's candle stream, and seeded
 * from REST/synthetic history on first access.
 */
@Injectable()
export class CandlesService {
  private readonly logger = new Logger(CandlesService.name);
  private readonly cache = new Map<string, Candle[]>();

  constructor(private readonly registry: PriceSourceRegistry) {}

  private key(symbol: string, timeframe: Timeframe): string {
    return `${symbol}:${timeframe}`;
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    fromMs?: number,
    toMs?: number,
  ): Promise<Candle[]> {
    const key = this.key(symbol, timeframe);
    let bars = this.cache.get(key);

    if (!bars || bars.length === 0) {
      bars = await this.registry.getCandles(symbol, timeframe, Math.max(limit, 300), fromMs, toMs);
      this.cache.set(key, bars);
    }

    let slice = bars;
    if (fromMs !== undefined) {
      slice = slice.filter((bar) => bar.time >= fromMs);
    }
    if (toMs !== undefined) {
      slice = slice.filter((bar) => bar.time <= toMs);
    }
    const tail = slice.slice(-Math.max(1, Math.min(limit, MAX_CACHED_BARS)));
    return tail.map((bar) => ({ ...bar }));
  }

  onCandle(symbol: string, timeframe: Timeframe, candle: Candle): Candle {
    const key = this.key(symbol, timeframe);
    const bars = this.cache.get(key);
    if (!bars || bars.length === 0) {
      // No cache yet — a consumer will seed it via REST; drop live updates
      // until then to avoid half-built history.
      return candle;
    }
    const last = bars[bars.length - 1];
    if (last && last.time === candle.time) {
      bars[bars.length - 1] = candle;
    } else if (!last || candle.time > last.time) {
      bars.push(candle);
      if (bars.length > MAX_CACHED_BARS) bars.splice(0, bars.length - MAX_CACHED_BARS);
    }
    return candle;
  }

  /** Last cached bar, if any (used to push a snapshot on subscribe). */
  latest(symbol: string, timeframe: Timeframe): Candle | null {
    const bars = this.cache.get(this.key(symbol, timeframe));
    return bars && bars.length > 0 ? { ...bars[bars.length - 1] } : null;
  }

  hasCache(symbol: string, timeframe: Timeframe): boolean {
    const bars = this.cache.get(this.key(symbol, timeframe));
    return !!bars && bars.length > 0;
  }
}
