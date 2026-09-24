# Integration guide — wiring a terminal frontend to kryptto

> **Status: implemented.** The OpenCharts terminal is vendored in
> [`frontend/`](../frontend) with this guide applied — see
> `frontend/src/services/backend/` (adapter), `frontend/README.md` (change
> list) and `frontend/src/__tests__/kryptto-ws-client.test.ts` (translation
> tests). The sections below remain as the reference for wiring any *other*
> frontend.

This guide shows how to connect an OpenCharts-class terminal (or any
frontend) to the kryptto backend. The full HTTP/WebSocket reference is in
[API.md](API.md); the OpenAPI spec is [`openapi.json`](../openapi.json).

## 1. Point the frontend at the API

OpenCharts' request wrapper resolves the base URL as:

```ts
export const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, "")}/api`
  : "/api";
```

So either:

- **Same origin** (recommended): serve the terminal from kryptto itself, or
  proxy `/api` and `/ws` in your dev server:

  ```ts
  // vite.config.ts
  export default {
    server: {
      proxy: {
        '/api': 'http://localhost:8080',
        '/ws': { target: 'ws://localhost:8080', ws: true },
      },
    },
  };
  ```

- **Direct**: `VITE_API_URL=http://localhost:8080` (CORS is enabled; restrict
  `CORS_ORIGINS` in production).

## 2. Auth

```ts
// one-click demo session (also what the built-in preview does)
const res = await fetch(`${API_BASE}/auth/demo`, { method: 'POST' });
const { accessToken, refreshToken, user } = await res.json();

// persist both; refresh before access-token expiry
const refreshed = await fetch(`${API_BASE}/auth/refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken }),
}).then((r) => r.json());
```

Errors always come back as `{ error: { code, message, details? } }` — a 401
with code `TOKEN_INVALID` means "refresh and retry".

## 3. REST facade

Map the terminal's API surface onto kryptto (domain schemas already match —
`User`, `Account`, `Order`, `Position`, `Fill` are 1:1):

```ts
// services/api.ts (terminal side)
const request = async (path, init = {}) => {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('access_token')}`,
      ...init.headers,
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code, json?.error?.message);
  return json?.data ?? json;
};

export const api = {
  // auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  demoLogin: () => request('/auth/demo', { method: 'POST' }),
  refreshToken: (rt) => request('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) }),
  logout: (rt) => request('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) }),

  // market data
  getSymbols: () => request('/market-data/symbols'),
  getTicks: () => request('/market-data/ticks'),
  getCandles: (symbol, timeframe, limit = 500) =>
    request(`/market-data/candles?symbol=${symbol}&timeframe=${timeframe}&limit=${limit}`),

  // accounts
  getMyAccounts: () => request('/accounts/me/list'),
  createAccount: (templateId, _userId, label) =>
    request('/accounts', { method: 'POST', body: JSON.stringify({ templateId, label }) }),
  getLedger: (id, page = 1, pageSize = 50) => request(`/accounts/${id}/ledger?page=${page}&pageSize=${pageSize}`),
  getEquityCurve: (id) => request(`/accounts/${id}/equity-curve`),
  getStats: (id) => request(`/accounts/${id}/stats`),

  // trading
  getPositions: (id) => request(`/accounts/${id}/positions`),
  getOrders: (id) => request(`/accounts/${id}/orders`),
  getFills: (id) => request(`/accounts/${id}/fills`),
  placeOrder: (dto) => request('/orders', { method: 'POST', body: JSON.stringify(dto) }),
  cancelOrder: (id) => request(`/orders/${id}`, { method: 'DELETE' }),
  closePosition: (id, quantity) => request(`/positions/${id}/close`, { method: 'POST', body: JSON.stringify({ quantity }) }),
};
```

## 4. WebSocket client

Drop-in replacement for OpenCharts' `services/ws.ts` (same public surface —
`connect / disconnect / reauthenticate / subscribe / onStateChange`):

```ts
export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
export type WsHandler = (event: any) => void;

class KrypttoWsClient {
  private socket: WebSocket | null = null;
  private token: string | null = null;
  private _state: ConnectionState = 'disconnected';
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private handlers = new Map<string, Set<WsHandler>>();

  get state() { return this._state; }

  private setState(next: ConnectionState) {
    this._state = next;
    this.stateListeners.forEach((cb) => cb(next));
  }

  connect(token?: string) {
    this.token = token ?? this.token;
    this.setState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const socket = new WebSocket(`${proto}://${location.host}/ws${query}`);
    this.socket = socket;

    socket.onopen = () => this.setState('connected');
    socket.onclose = () => {
      this.setState('reconnecting');
      setTimeout(() => this.connect(), Math.min(10_000, 1000 * 2 ** Math.random() * 3));
    };
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.channel) {
        this.handlers.get(msg.channel)?.forEach((h) => h(msg.event));
      } else if (msg.type === 'authenticated') {
        this.subscribe('account');
      }
    };
  }

  disconnect() { this.socket?.close(); this.socket = null; this.setState('disconnected'); }
  reauthenticate(token: string) { this.token = token; this.socket?.send(JSON.stringify({ op: 'auth', token })); }

  subscribe(channel: string, handler: WsHandler): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      this.socket?.send(JSON.stringify({ op: 'subscribe', channel }));
    }
    this.handlers.get(channel)!.add(handler);
    return () => {
      this.handlers.get(channel)?.delete(handler);
      // (optionally unsubscribe when the last handler for a channel leaves)
    };
  }

  // OpenCharts helpers map naturally:
  //   setSymbolInterest(symbols)  → subscribe/unsubscribe `candles:SYM:tf` channels
  //   subscribeAccounts(_ids)     → subscribe('account') (user-scoped server-side)

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb); cb(this._state);
    return () => this.stateListeners.delete(cb);
  }
}

export const wsClient = new KrypttoWsClient();
```

### Channel cheat-sheet

```ts
wsClient.subscribe(`ticks`, (t) => { /* {symbol, bid, ask, last, timestamp} */ });
wsClient.subscribe(`candles:${symbol}:${tf}`, (c) => chart.update(c));   // partial + closed bars
wsClient.subscribe(`orderbook:${symbol}`, (b) => depth.render(b));
wsClient.subscribe(`trades:${symbol}`, (t) => tape.push(t));
wsClient.subscribe(`account`, (e) => {
  switch (e.type) {
    case 'order':           /* order snapshot */ break;
    case 'fill':            /* execution */ break;
    case 'position':        /* position upsert */ break;
    case 'position_closed': /* realized P&L */ break;
    case 'balance':         /* account snapshot */ break;
  }
});
```

## 5. Boot sequence for a terminal

1. `POST /auth/demo` (or login) → tokens.
2. `GET /market-data/symbols` → symbol universe + contract metadata.
3. `GET /accounts/me/list` → pick/label accounts.
4. Connect WS with token; subscribe `ticks`, `status`, `account`.
5. On symbol/timeframe focus: `GET /market-data/candles` for history, then
   subscribe `candles:SYM:tf` for live updates (interest-driven — the server
   only streams what you subscribe).
6. Render order ticket → `POST /orders`; update optimistically and reconcile
   on `account` events (fills always arrive server-side).

## 6. Verifying your integration

- `GET /api/status` → `marketData.mode` tells you if you're on live Binance
  data or the built-in simulator (identical shapes either way).
- The built-in preview at `/` is a complete reference client — view source
  for a from-scratch implementation of every flow above.
- `npm test` in `server/` runs the same flows end-to-end (21 tests).
