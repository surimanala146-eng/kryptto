import { describe, expect, it, vi } from "vitest";
import { KrypttoWsClient } from "../services/backend/ws.ts";

/**
 * Verifies the kryptto → OpenCharts event translation: the exact frames the
 * kryptto backend sends must come out as the channel events MarketDataBridge
 * consumes (MarketTick / CandleUpdate / CandleClosed / OrderPlaced /
 * OrderFilled / OrderCanceled / PositionOpened / PositionUpdated /
 * PositionClosed / EquityUpdated).
 */

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // test helpers
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  sentOps(): Array<{ op: string; channel: string }> {
    return this.sent.map((raw) => JSON.parse(raw) as { op: string; channel: string });
  }
}

function makeClient(): { client: KrypttoWsClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  const client = new KrypttoWsClient(() => socket);
  return { client, socket };
}

describe("KrypttoWsClient", () => {
  it("connects, authenticates via query token and subscribes base channels", () => {
    const { client, socket } = makeClient();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    client.connect("tok-123");
    socket.simulateOpen();

    expect(states).toEqual(["disconnected", "connecting", "connected"]);
    const ops = socket.sentOps();
    expect(ops).toContainEqual({ op: "subscribe", channel: "ticks" });
    expect(ops).toContainEqual({ op: "subscribe", channel: "account" });
  });

  it("translates ticks into MarketTick market-data events", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    const events: unknown[] = [];
    client.subscribe("market-data", (e) => events.push(e));

    socket.simulateMessage({
      channel: "ticks",
      event: { symbol: "BTCUSDT", bid: 67100.1, ask: 67100.9, last: 67100.5, timestamp: 1790000000000 },
    });

    expect(events).toContainEqual({
      eventType: "MarketTick",
      symbol: "BTCUSDT",
      bid: 67100.1,
      ask: 67100.9,
      occurredAt: 1790000000000,
    });
  });

  it("translates candle frames into CandleUpdate / CandleClosed", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    const events: unknown[] = [];
    client.subscribe("market-data", (e) => events.push(e));

    socket.simulateMessage({
      channel: "candles:BTCUSDT:1m",
      event: { time: 1790000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closed: false },
    });
    socket.simulateMessage({
      channel: "candles:BTCUSDT:1m",
      event: { time: 1790000000000, open: 1, high: 2, low: 0.5, close: 1.6, volume: 12, closed: true },
    });

    expect(events[0]).toEqual({
      eventType: "CandleUpdate",
      symbol: "BTCUSDT",
      timeframe: "1m",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      timestamp: 1790000000000,
    });
    expect(events[1]).toMatchObject({ eventType: "CandleUpdate", close: 1.6 });
    expect(events[2]).toEqual({ eventType: "CandleClosed", symbol: "BTCUSDT", timeframe: "1m" });
  });

  it("translates order events with _entity for direct cache updates", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    const events: unknown[] = [];
    client.subscribe("orders", (e) => events.push(e));

    const order = { id: "o1", accountId: "a1", status: "OPEN", symbolName: "BTCUSDT" };
    socket.simulateMessage({ channel: "account", event: { type: "order", order } });
    socket.simulateMessage({
      channel: "account",
      event: { type: "order", order: { ...order, status: "FILLED", avgFillPrice: 100 } },
    });
    socket.simulateMessage({
      channel: "account",
      event: { type: "order", order: { ...order, status: "CANCELLED" } },
    });

    expect(events[0]).toMatchObject({ eventType: "OrderPlaced", orderId: "o1", _entity: order });
    expect(events[1]).toMatchObject({ eventType: "OrderFilled" });
    expect(events[2]).toMatchObject({ eventType: "OrderCanceled" });
  });

  it("translates positions: first sighting Opened, then Updated, then Closed", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    const events: unknown[] = [];
    client.subscribe("positions", (e) => events.push(e));

    const position = {
      id: "p1",
      accountId: "a1",
      entryPrice: 100,
      unrealizedPnl: 5,
      quantity: 2,
      symbolName: "ETHUSDT",
    };
    socket.simulateMessage({ channel: "account", event: { type: "position", position } });
    socket.simulateMessage({
      channel: "account",
      event: { type: "position", position: { ...position, unrealizedPnl: 7 } },
    });
    socket.simulateMessage({
      channel: "account",
      event: { type: "position_closed", closed: { id: "p1", accountId: "a1" } },
    });
    // A position re-opened later (same id after close) is Opened again.
    socket.simulateMessage({ channel: "account", event: { type: "position", position } });

    expect(events[0]).toMatchObject({ eventType: "PositionOpened", _entity: position });
    expect(events[1]).toMatchObject({ eventType: "PositionUpdated", unrealizedPnl: 7, quantity: 2, averagePrice: 100 });
    expect(events[2]).toMatchObject({ eventType: "PositionClosed", positionId: "p1" });
    expect(events[3]).toMatchObject({ eventType: "PositionOpened" });
  });

  it("translates balance snapshots into EquityUpdated account events", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    const events: unknown[] = [];
    client.subscribe("account", (e) => events.push(e));

    socket.simulateMessage({
      channel: "account",
      event: {
        type: "balance",
        account: { id: "a1", equity: 100_500, balance: 100_000, freeMargin: 90_000, margin: 10_000 },
      },
    });

    expect(events).toContainEqual({
      eventType: "EquityUpdated",
      accountId: "a1",
      equity: 100_500,
      balance: 100_000,
      freeMargin: 90_000,
      marginUsed: 10_000,
    });
  });

  it("focuses the chart stream and switches subscriptions", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    client.setChartStream("BTCUSDT", "15m");
    client.setChartStream("ETHUSDT", "1m");

    const ops = socket.sentOps();
    expect(ops).toContainEqual({ op: "subscribe", channel: "candles:BTCUSDT:15m" });
    expect(ops).toContainEqual({ op: "unsubscribe", channel: "candles:BTCUSDT:15m" });
    expect(ops).toContainEqual({ op: "subscribe", channel: "candles:ETHUSDT:1m" });
  });

  it("re-authenticates over an open socket without reconnecting", () => {
    const { client, socket } = makeClient();
    client.connect("old");
    socket.simulateOpen();
    socket.sent.length = 0;

    client.reauthenticate("new-token");
    expect(socket.sent).toEqual([JSON.stringify({ op: "auth", token: "new-token" })]);
  });

  it("isolates faulty subscribers", () => {
    const { client, socket } = makeClient();
    client.connect("t");
    socket.simulateOpen();

    const boom = vi.fn(() => {
      throw new Error("subscriber bug");
    });
    const ok = vi.fn();
    client.subscribe("market-data", boom);
    client.subscribe("market-data", ok);

    socket.simulateMessage({
      channel: "ticks",
      event: { symbol: "X", bid: 1, ask: 2, last: 1.5, timestamp: 1 },
    });

    expect(boom).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
  });
});
