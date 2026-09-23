/**
 * WebSocket client for the kryptto backend (server/ in this monorepo).
 *
 * Exposes the exact surface the terminal already consumes (see
 * services/demo/ws-client.ts): connect / disconnect / reauthenticate /
 * subscribe / subscribeAccounts / setSymbolInterest / onStateChange, plus
 * setChartStream() used by TradingPage to focus candle streaming.
 *
 * Translation layer — kryptto channels → OpenCharts channels:
 *
 *   kryptto "ticks"                      → OC "market-data" {eventType:"MarketTick"}
 *   kryptto "candles:SYM:tf"             → OC "market-data" {eventType:"CandleUpdate"|"CandleClosed"}
 *   kryptto "account" {type:"order"}     → OC "orders"    {eventType:"OrderPlaced"|"OrderFilled"|"OrderCanceled", _entity}
 *   kryptto "account" {type:"position"}  → OC "positions" {eventType:"PositionOpened"|"PositionUpdated", _entity}
 *   kryptto "account" {type:"position_closed"} → OC "positions" {eventType:"PositionClosed"}
 *   kryptto "account" {type:"balance"}   → OC "account"   {eventType:"EquityUpdated"}
 */
import type { ConnectionState, WsClient, WsHandler } from "../ws-types.ts";

/** kryptto wire types (see server docs/API.md). */
interface KrypttoTick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
}

interface KrypttoCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

interface KrypttoOrder {
  id: string;
  accountId: string;
  status: string;
  [key: string]: unknown;
}

interface KrypttoPosition {
  id: string;
  accountId: string;
  entryPrice: number;
  unrealizedPnl: number;
  quantity: number;
  [key: string]: unknown;
}

type KrypttoAccountEvent =
  | { type: "order"; order: KrypttoOrder }
  | { type: "fill"; fill: Record<string, unknown> }
  | { type: "position"; position: KrypttoPosition }
  | { type: "position_closed"; closed: { id: string; accountId?: string } & Record<string, unknown> }
  | { type: "balance"; account: Record<string, number | string | null> & { id: string } };

function wsBaseUrl(): string {
  // Direct mode (VITE_API_URL set) → derive ws://host from it; otherwise
  // same-origin (the Vite dev server proxies /ws to the backend).
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit.replace(/\/$/, "");
  const apiBase = import.meta.env.VITE_API_URL as string | undefined;
  if (apiBase) {
    return apiBase.replace(/^http/, "ws").replace(/\/$/, "");
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

const ORDER_EVENT_BY_STATUS: Record<string, string> = {
  OPEN: "OrderPlaced",
  FILLED: "OrderFilled",
  CANCELLED: "OrderCanceled",
  REJECTED: "OrderCanceled",
};

/** Injectable socket factory — lets tests drive the client with a fake. */
export type WebSocketFactory = (url: string) => Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

const defaultWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url);

export class KrypttoWsClient implements WsClient {
  private socket: ReturnType<WebSocketFactory> | null = null;
  private token: string | null = null;
  private _state: ConnectionState = "disconnected";
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly handlers = new Map<string, Set<WsHandler>>();

  private chartStream: { symbol: string; timeframe: string } | null = null;
  private subscribedKrypttoChannels = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;

  /** Position ids seen on this connection — decides Opened vs Updated. */
  private seenPositionIds = new Set<string>();

  constructor(private readonly createSocket: WebSocketFactory = defaultWebSocketFactory) {}

  get state(): ConnectionState {
    return this._state;
  }

  private setState(next: ConnectionState): void {
    if (this._state === next) return;
    this._state = next;
    for (const cb of [...this.stateListeners]) cb(next);
  }

  // ── connection lifecycle ───────────────────────────────

  connect(token?: string): void {
    if (token) this.token = token;
    this.manuallyClosed = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.open();
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.socket?.close(1000, "client disconnect");
    this.socket = null;
    this.subscribedKrypttoChannels.clear();
    this.setState("disconnected");
  }

  reauthenticate(token: string): void {
    this.token = token;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ op: "auth", token }));
    }
  }

  private open(): void {
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const socket = this.createSocket(`${wsBaseUrl()}/ws${query}`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.subscribedKrypttoChannels.clear();
      this.seenPositionIds.clear();
      this.resubscribeAll();
      this.setState("connected");
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: { channel?: string; event?: unknown } & Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg.channel !== "string" || msg.event === undefined) return;
      this.route(msg.channel, msg.event);
    };

    socket.onclose = () => {
      this.subscribedKrypttoChannels.clear();
      if (this.manuallyClosed) {
        this.setState("disconnected");
        return;
      }
      this.setState("reconnecting");
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.reconnectAttempts, 5));
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };

    socket.onerror = () => {
      // onclose follows; nothing else to do.
    };
  }

  // ── kryptto channel subscriptions ──────────────────────

  private send(op: string, channel: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ op, channel }));
  }

  private subscribeKryptto(channel: string): void {
    if (this.subscribedKrypttoChannels.has(channel)) return;
    this.subscribedKrypttoChannels.add(channel);
    this.send("subscribe", channel);
  }

  private unsubscribeKryptto(channel: string): void {
    if (!this.subscribedKrypttoChannels.has(channel)) return;
    this.subscribedKrypttoChannels.delete(channel);
    this.send("unsubscribe", channel);
  }

  private resubscribeAll(): void {
    // ticks drive the watchlist + tick-smoothed chart bars
    this.subscribeKryptto("ticks");
    if (this.token) this.subscribeKryptto("account");
    if (this.chartStream) {
      this.subscribeKryptto(`candles:${this.chartStream.symbol}:${this.chartStream.timeframe}`);
    }
  }

  // ── public surface ─────────────────────────────────────

  subscribe(channel: string, handler: WsHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  subscribeAccounts(_accountIds: string[]): void {
    // kryptto's "account" channel is user-scoped server-side; the id list is
    // only needed by upstream multi-account gateways. Ensure we're listening.
    if (this.socket?.readyState === WebSocket.OPEN && this.token) {
      this.subscribeKryptto("account");
    }
  }

  setSymbolInterest(_symbols: string[]): void {
    // kryptto's "ticks" channel already streams the whole universe.
  }

  /** Focus server-aggregated candle streaming on one symbol+timeframe. */
  setChartStream(symbol: string, timeframe: string): void {
    const previous = this.chartStream;
    if (previous && previous.symbol === symbol && previous.timeframe === timeframe) return;
    this.chartStream = { symbol, timeframe };
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (previous) this.unsubscribeKryptto(`candles:${previous.symbol}:${previous.timeframe}`);
    this.subscribeKryptto(`candles:${symbol}:${timeframe}`);
  }

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  // ── event translation ──────────────────────────────────

  private emit(channel: string, event: unknown): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch {
        // a faulty subscriber must never kill the stream
      }
    }
  }

  private route(channel: string, raw: unknown): void {
    if (channel === "ticks" || channel.startsWith("ticks:")) {
      const tick = raw as KrypttoTick;
      this.emit("market-data", {
        eventType: "MarketTick",
        symbol: tick.symbol,
        bid: tick.bid,
        ask: tick.ask,
        occurredAt: tick.timestamp,
      });
      return;
    }

    if (channel.startsWith("candles:")) {
      // candles:SYMBOL:TIMEFRAME
      const symbol = channel.slice("candles:".length, channel.lastIndexOf(":"));
      const timeframe = channel.slice(channel.lastIndexOf(":") + 1);
      const candle = raw as KrypttoCandle;
      this.emit("market-data", {
        eventType: "CandleUpdate",
        symbol,
        timeframe,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        timestamp: candle.time, // ms — ChartPanel normalizes via toUnixSeconds
      });
      if (candle.closed) {
        this.emit("market-data", { eventType: "CandleClosed", symbol, timeframe });
      }
      return;
    }

    if (channel === "account") {
      this.routeAccountEvent(raw as KrypttoAccountEvent);
      return;
    }

    // stats:*, orderbook:*, trades:*, status — not consumed by OpenCharts.
  }

  private routeAccountEvent(event: KrypttoAccountEvent): void {
    switch (event?.type) {
      case "order": {
        const order = event.order;
        if (!order?.accountId) return;
        this.emit("orders", {
          eventType: ORDER_EVENT_BY_STATUS[order.status] ?? "OrderPlaced",
          accountId: order.accountId,
          orderId: order.id,
          _entity: order,
        });
        return;
      }

      case "fill": {
        // The companion "order" event already carries the full entity; the
        // fills table is refreshed through its query lifecycle.
        return;
      }

      case "position": {
        const position = event.position;
        if (!position?.accountId) return;
        const isNew = !this.seenPositionIds.has(position.id);
        this.seenPositionIds.add(position.id);
        this.emit("positions", {
          eventType: isNew ? "PositionOpened" : "PositionUpdated",
          accountId: position.accountId,
          positionId: position.id,
          unrealizedPnl: position.unrealizedPnl,
          quantity: position.quantity,
          averagePrice: position.entryPrice,
          _entity: position,
        });
        return;
      }

      case "position_closed": {
        const closed = event.closed;
        this.seenPositionIds.delete(closed?.id ?? "");
        this.emit("positions", {
          eventType: "PositionClosed",
          accountId: closed?.accountId ?? "",
          positionId: closed?.id ?? "",
        });
        return;
      }

      case "balance": {
        const acc = event.account as unknown as {
          id: string;
          equity?: number;
          balance?: number;
          freeMargin?: number;
          margin?: number;
        } | undefined;
        if (!acc?.id) return;
        this.emit("account", {
          eventType: "EquityUpdated",
          accountId: acc.id,
          equity: acc.equity,
          balance: acc.balance,
          freeMargin: acc.freeMargin,
          marginUsed: acc.margin,
        });
        return;
      }

      default:
        return;
    }
  }
}
