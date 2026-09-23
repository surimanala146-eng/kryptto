# kryptto

**Open-source trading platform: a TradingView-class terminal frontend
(OpenCharts) powered by a dedicated market-data + paper-trading backend.**

The frontend landscape was researched and analysed in
[docs/RESEARCH.md](docs/RESEARCH.md); the winner — **OpenCharts** (MIT,
deliberately backend-agnostic) — is vendored in [`frontend/`](frontend) and
wired to the kryptto backend in [`server/`](server) through a thin, tested
adapter layer (`frontend/src/services/backend/`).

- **Live market data** from Binance's public REST + WebSocket APIs (no API
  key), with an **always-available simulator fallback** — the platform boots
  and streams even with zero internet access, then upgrades to live data
  automatically.
- **Paper-trading engine**: MARKET/LIMIT/STOP orders, take-profit/stop-loss,
  netted LONG/SHORT positions with leverage and margin, commissions, realized
  P&L, cash ledger, equity curve, performance stats.
- **JWT auth** with refresh-token rotation, plus one-click demo sessions.
- **Realtime hub** over plain WebSockets: ticks, candles, order books,
  trades, 24h stats and authenticated account events — all channel-based and
  interest-driven.
- **Zero external services**: SQLite via Node's built-in `node:sqlite`,
  in-memory caches. Runs as a single `node` process or one small container.
- **Built-in terminal preview** at `/` — a complete single-file reference
  client exercising every endpoint and channel.
- **OpenAPI 3 spec** at `/api/docs` (Swagger UI) and [`openapi.json`](openapi.json).

## Quick start

```bash
# option A — docker (backend + its built-in preview page)
docker compose up --build          # → http://localhost:8080

# option B — full stack (backend + OpenCharts terminal)
cd server  && npm install && npm run build && npm start   # API on :8080
cd frontend && npm install && npm run dev                 # terminal on :5173
```

Open **http://localhost:5173** — the OpenCharts terminal boots a one-click
demo session against the backend: $100k paper account, live market data
(Binance when reachable, built-in simulator otherwise), server-side order
matching with TP/SL, and authenticated WebSocket streams.

The backend also serves a minimal single-file reference client at
http://localhost:8080/ (`SERVE_PREVIEW=true`).

```bash
# poke the API directly
curl -s localhost:8080/api/status | jq
TOKEN=$(curl -s -X POST localhost:8080/api/auth/demo | jq -r .accessToken)
curl -s localhost:8080/api/market-data/ticks/BTCUSDT | jq
curl -s -X POST localhost:8080/api/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountId":"<from /api/accounts/me/list>","symbolName":"BTCUSDT",
       "side":"BUY","type":"MARKET","quantity":0.5}' | jq
```

## Repository layout

```
├── frontend/             # OpenCharts terminal (MIT, vendored) + kryptto adapter
│   ├── src/services/backend/   # API + WS adapter for the kryptto backend
│   └── src/services/demo/      # upstream in-browser demo layer (kept working)
├── server/               # NestJS backend
│   ├── src/
│   │   ├── auth/         # JWT access+refresh, demo sessions
│   │   ├── market-data/  # symbols, ticks, candles, orderbooks, stats
│   │   ├── trading/      # accounts, orders, positions, matching engine
│   │   ├── price-source/ # Binance live source + simulator + registry
│   │   ├── realtime/     # /ws channel hub
│   │   ├── persistence/  # node:sqlite database + migrations
│   │   └── config/       # typed env configuration
│   ├── public/index.html # terminal preview (reference client)
│   └── test/             # vitest unit + e2e suites
├── docs/                 # research, architecture, API, integration guides
├── openapi.json          # generated OpenAPI 3 spec (29 paths)
├── Dockerfile
└── docker-compose.yml
```

## Configuration

See [`server/.env.example`](server/.env.example). Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP + WS listener |
| `MARKET_DATA_MODE` | `auto` | `auto` \| `live` \| `simulated` |
| `BINANCE_MAX_SYMBOLS` | `120` | Universe size (by 24h volume) |
| `DATABASE_PATH` | `data/kryptto.db` | SQLite file (`:memory:` for ephemeral) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev values | **Change in production** |
| `CORS_ORIGINS` | `*` | Comma-separated origins |

## Testing

```bash
cd server   && npm test   # 22 tests: simulator unit + full API e2e (in-memory DB)
cd frontend && npm test   # 34 tests: upstream suite + kryptto WS-translation unit tests
```

No network, no external services, no flakiness.

## Documentation

- [docs/RESEARCH.md](docs/RESEARCH.md) — frontend landscape research & the decision
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design & data flow
- [docs/API.md](docs/API.md) — REST + WebSocket reference
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — wiring a terminal frontend (drop-in code)

## Status / roadmap

- [x] Market data: live Binance + simulator, candles/ticks/books/trades/stats
- [x] Paper trading: orders, netting, TP/SL, margin, ledger, equity, stats
- [x] Realtime: channel hub with auth + interest-driven streaming
- [x] OpenAPI spec, Swagger UI, terminal preview, e2e tests, Docker
- [x] Frontend phase: OpenCharts vendored + `api`/`ws` facades implemented & tested
- [ ] Postgres store option, multi-venue aggregation, real order book

## License

MIT.
