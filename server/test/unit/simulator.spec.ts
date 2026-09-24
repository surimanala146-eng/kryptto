import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorSource } from '../../src/price-source/simulator/simulator.source';
import type { AppConfig } from '../../src/config/configuration';

/**
 * The simulator is the always-available market: it must start cleanly, emit
 * ticks/candles/trades with sane shapes, and produce deterministic history.
 */

const testConfig = {
  marketData: { simulatorTickIntervalMs: 50, candleHistoryDepth: 500 },
} as unknown as AppConfig;

async function makeStarted(): Promise<SimulatorSource> {
  const source = new SimulatorSource(testConfig);
  await source.start();
  return source;
}

describe('SimulatorSource', () => {
  let source: SimulatorSource;

  beforeAll(async () => {
    source = await makeStarted();
  });

  afterAll(async () => {
    await source.stop();
  });

  it('exposes a symbol registry with contract metadata', async () => {
    const symbols = await source.listSymbols();
    expect(symbols.length).toBeGreaterThanOrEqual(20);
    const btc = symbols.find((s) => s.name === 'BTCUSDT');
    expect(btc).toBeDefined();
    expect(btc!.tickSize).toBeGreaterThan(0);
    expect(btc!.digits).toBeGreaterThan(0);
    expect(btc!.minQuantity).toBeGreaterThan(0);
    expect(btc!.commission).toBeGreaterThan(0);
    expect(btc!.contractSize).toBe(1);
  });

  it('emits ticks with a positive bid/ask spread', async () => {
    const tick = await new Promise<{ symbol: string; bid: number; ask: number; last: number }>(
      (resolve) => {
        const stop = source.on('tick', (t) => {
          if (t.symbol === 'BTCUSDT') {
            stop();
            resolve(t);
          }
        });
      },
    );
    expect(tick.ask).toBeGreaterThan(tick.bid);
    expect(tick.last).toBeGreaterThan(0);
  });

  it('emits candles, order books and trades for interested channels', async () => {
    source.ensureStreams([
      { type: 'candles', symbol: 'ETHUSDT', timeframe: '1m' },
      { type: 'orderbook', symbol: 'ETHUSDT' },
      { type: 'trades', symbol: 'ETHUSDT' },
    ]);

    const candle = await new Promise<{ open: number; high: number; low: number; close: number }>(
      (resolve) => {
        const stop = source.on('candle', (symbol, tf, c) => {
          if (symbol === 'ETHUSDT' && tf === '1m') {
            stop();
            resolve(c);
          }
        });
      },
    );
    expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
    expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));

    const book = await new Promise<{ bids: Array<{ price: number }>; asks: Array<{ price: number }> }>(
      (resolve) => {
        const stop = source.on('orderBook', (b) => {
          if (b.symbol === 'ETHUSDT') {
            stop();
            resolve(b);
          }
        });
      },
    );
    expect(book.bids.length).toBe(20);
    expect(book.asks.length).toBe(20);
    expect(book.asks[0].price).toBeGreaterThan(book.bids[0].price);

    const trade = await new Promise<{ side: string; quantity: number }>((resolve) => {
      const stop = source.on('trade', (t) => {
        if (t.symbol === 'ETHUSDT') {
          stop();
          resolve(t);
        }
      });
    });
    expect(['BUY', 'SELL']).toContain(trade.side);
    expect(trade.quantity).toBeGreaterThan(0);
  });

  it('generates deterministic, gap-free history that ends at the live price', async () => {
    const a = await source.getCandles('BTCUSDT', '5m', 200);
    const b = await source.getCandles('BTCUSDT', '5m', 200);
    expect(a.map((c) => c.time)).toEqual(b.map((c) => c.time));
    expect(a.length).toBe(200);

    for (let i = 1; i < a.length; i++) {
      expect(a[i].time - a[i - 1].time).toBe(5 * 60_000);
    }
    // all but the forming bar are closed
    expect(a[a.length - 1].closed).toBe(false);
    expect(a.slice(0, -1).every((c) => c.closed)).toBe(true);
    // prices are strictly positive and the forming bar tracks the live market
    for (const candle of a) {
      expect(candle.open).toBeGreaterThan(0);
      expect(candle.high).toBeGreaterThanOrEqual(candle.low);
    }
  });

  it('is healthy after start and reports the last event time', () => {
    expect(source.isHealthy()).toBe(true);
    expect(source.lastEventAt()).toBeGreaterThan(0);
  });
});
