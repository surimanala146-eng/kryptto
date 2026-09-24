# API reference

Base URL: `http://localhost:8080/api` · Interactive docs: **`/api/docs`** (Swagger UI) ·
Machine-readable spec: [`openapi.json`](../openapi.json) (29 paths).

- Success → `200`/`201` with the resource JSON directly.
- Error → `{ "error": { "code": "MACHINE_CODE", "message": "…", "details": {…} } }`.
- Authenticated routes need `Authorization: Bearer <accessToken>`.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{email, password, firstName?, lastName?}` | Creates user **and** a `demo-standard` paper account ($100k, 10×) |
| POST | `/auth/login` | `{email, password}` | → `{accessToken, refreshToken, user}` |
| POST | `/auth/demo` | – | Instant throwaway user + fresh $100k paper account |
| POST | `/auth/refresh` | `{refreshToken}` | Rotates the refresh token (old one is revoked) |
| POST | `/auth/logout` | `{refreshToken}` | Revokes the refresh token |
| GET | `/auth/me` | – | Current user |

## Market data (public)

| Method | Path | Notes |
|---|---|---|
| GET | `/market-data/symbols` | Contract metadata (tickSize, digits, minQuantity, commission, maxLeverage, …) |
| GET | `/market-data/ticks` | `{ "BTCUSDT": {symbol, bid, ask, last, timestamp}, … }` |
| GET | `/market-data/ticks/:symbol` | Latest bid/ask |
| GET | `/market-data/stats/:symbol` | Rolling 24h (change %, high, low, volume) |
| GET | `/market-data/candles?symbol=BTCUSDT&timeframe=1m&limit=500&fromMs=&toMs=` | → `{candles:[{time, open, high, low, close, volume, closed}], metadata:{historicalCoverageStart, isPartial, backfillQueued}}` |
| GET | `/market-data/orderbook/:symbol` | Latest L2 snapshot (streams once a WS client subscribes) |
| GET | `/market-data/trades/:symbol` | Recent public trades |

Timeframes: `1m 5m 15m 30m 1h 4h 1d 1w`.

## Trading (authenticated)

| Method | Path | Notes |
|---|---|---|
| GET | `/accounts/me/list` | Accounts with live `equity/margin/freeMargin` |
| GET | `/accounts/templates` | Available templates (`demo-standard` $100k×10, `demo-mini` $10k×20, `evaluation-pro` $25k×5) |
| POST | `/accounts` | `{templateId, label?}` |
| GET | `/accounts/:id` | Single account |
| GET | `/accounts/:id/positions` | Open positions with mark price + unrealized P&L |
| GET | `/accounts/:id/orders?status=&page=&pageSize=` | Order history |
| GET | `/accounts/:id/fills?page=&pageSize=` | Execution history |
| GET | `/accounts/:id/closed-positions` | Closed trades (entry/exit/realized) |
| GET | `/accounts/:id/ledger?page=&pageSize=` | Cash movements (DEPOSIT, COMMISSION, REALIZED_PNL) |
| GET | `/accounts/:id/equity-curve?fromMs=&toMs=` | Downsampled equity/balance history |
| GET | `/accounts/:id/stats` | winRate, profitFactor, avgWin/Loss, best/worst, expectancy, maxDrawdown, sharpeRatio |
| POST | `/orders` | See below |
| DELETE | `/orders/:id` | Cancel a resting order |
| PATCH | `/orders/:id` | Amend `{takeProfit?, stopLoss?}` on a resting order |
| PATCH | `/positions/:id` | Amend `{takeProfit?, stopLoss?}` on a position |
| POST | `/positions/:id/close` | `{quantity?}` — market-close (partial supported) |

### Placing an order

```json
POST /api/orders
{
  "accountId": "01J…",
  "symbolName": "BTCUSDT",
  "side": "BUY",            // BUY | SELL
  "type": "MARKET",         // MARKET | LIMIT | STOP
  "quantity": 0.5,
  "price": 67450.1,          // LIMIT only, must be aligned to tickSize
  "stopPrice": 68000.0,      // STOP only
  "takeProfit": 71000.0,     // optional
  "stopLoss": 65000.0,       // optional
  "comment": "breakout"      // optional
}
```

- MARKET fills immediately (BUY at ask, SELL at bid).
- Marketable LIMIT/STOP orders fill immediately at the better price.
- Otherwise the order rests until the tick stream triggers it.
- TP/SL attached to an order are applied to the resulting position and
  evaluated on every tick (engine-executed as internal MARKET orders).

### Error codes worth handling client-side

`UNAUTHORIZED`, `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`,
`ACCOUNT_FORBIDDEN`, `ACCOUNT_NOT_FOUND`, `SYMBOL_NOT_FOUND`,
`TICK_NOT_READY`, `PRICE_REQUIRED`, `PRICE_NOT_ALIGNED`,
`QUANTITY_TOO_SMALL`, `INSUFFICIENT_MARGIN`, `INVALID_PROTECTION`,
`ORDER_NOT_CANCELLABLE`, `MARKET_DATA_STARTING`.

## WebSocket — `/ws`

Plain `ws` (no socket.io). Authenticate via `?token=<accessToken>` or an
`auth` op after connecting. Frames are JSON.

```js
const ws = new WebSocket(`wss://host/ws?token=${accessToken}`);

// client → server
{ "op": "subscribe",   "channel": "candles:BTCUSDT:1m" }
{ "op": "unsubscribe", "channel": "candles:BTCUSDT:1m" }
{ "op": "auth",        "token": "<accessToken>" }
{ "op": "ping" }

// server → client
{ "channel": "candles:BTCUSDT:1m", "event": { "time": …, "open": …, "closed": false } }
{ "type": "subscribed"|"unsubscribed"|"authenticated"|"error"|"pong", … }
```

### Channels

| Channel | Payload | Auth |
|---|---|---|
| `ticks` | `{symbol, bid, ask, last, timestamp}` — all symbols | public |
| `ticks:BTCUSDT` | single-symbol ticks | public |
| `candles:BTCUSDT:1m` | `{time, open, high, low, close, volume, closed}` (partial + closed bars) | public |
| `orderbook:BTCUSDT` | `{bids[], asks[], timestamp}` — L2, 20 levels | public |
| `trades:BTCUSDT` | `{id, price, quantity, side, timestamp}` | public |
| `stats:BTCUSDT` | 24h statistics | public |
| `account` | `{type: "order"\|"fill"\|"position"\|"position_closed"\|"balance", …}` — scoped to your accounts only | **required** |
| `status` | market-data source status (live/simulated, health) | public |

## Status

`GET /api/status` → `{service, version, uptimeSeconds, marketData: {mode:
"live"|"simulated", provider, healthy, symbols, lastTickAt, note}, realtime:
{clients, endpoint}, time}`.
