# Architecture

```
                                ┌─────────────────────────────────────────┐
                                │              browser / terminal         │
                                │   REST (fetch, Bearer JWT)   WS client  │
                                └───────────┬──────────────────┬──────────┘
                                            │ /api/*           │ /ws
┌───────────────────────────────────────────▼──────────────────▼──────────┐
│                            NestJS application                            │
│                                                                          │
│  AuthModule        MarketDataModule         TradingModule                │
│  ├─ /auth/*        ├─ /market-data/*        ├─ /accounts/*               │
│  │  JWT access+    ├─ symbols registry      ├─ /orders  /positions       │
│  │  refresh        ├─ tick / stats cache     │   MatchingEngineService    │
│  │  demo login     ├─ CandlesService         │   (fills, netting, TP/SL,  │
│  └─ JwtAuthGuard   └─ interest management    │    margin, ledger, equity) │
│                                                                          │
│  RealtimeModule (ws hub)            StatusModule (/status)               │
│                                                                          │
│  PersistenceModule — SQLite (node:sqlite, zero native deps)              │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ PriceSourceEvents (tick/candle/book/trade/stats)
                 ┌─────────────▼──────────────┐
                 │   PriceSourceRegistry       │  mode: auto | live | simulated
                 │  ┌───────────────────────┐  │
                 │  │ BinanceSource         │  │  REST bootstrap (exchangeInfo,
                 │  │ REST + combined WS    │  │  klines) + combined WS stream
                 │  └───────────────────────┘  │
                 │  ┌───────────────────────┐  │
                 │  │ SimulatorSource       │  │  GBM price engine, synthetic
                 │  │ (always available)    │  │  candles/books/trades/stats
                 │  └───────────────────────┘  │
                 └────────────────────────────┘
```

## Module responsibilities

| Module | Owns |
|---|---|
| `config/` | Typed env config (`CONFIG` token), loaded once |
| `persistence/` | `node:sqlite` database + migrations; `DatabaseService` (generic `prepare<Row>()`) |
| `price-source/` | `PriceSource` interface + `BinanceSource`, `SimulatorSource`, `PriceSourceRegistry` (auto-failover / upgrade) |
| `market-data/` | Symbol registry, live tick/stats/book caches, `CandlesService` (ring-buffer cache), interest-driven stream fan-out |
| `auth/` | Registration, login, demo provisioning, refresh-token rotation & revocation, `JwtAuthGuard` (in `common/guards`) |
| `trading/` | Account templates, order placement/validation, the matching engine, positions, ledger, equity snapshots, stats |
| `realtime/` | The `ws` hub at `/ws`: channel pub/sub, per-connection auth, interest refcounting, heartbeats |
| `status/` | `/api/status` — health, market-data mode, client counts |

## Key design decisions

### 1. One price-source abstraction, two implementations
Everything downstream (candles, ticks, engine, WS) consumes the
`PriceSource` interface. `MARKET_DATA_MODE=auto` tries Binance first and falls
back to the simulator when the network is unavailable (e.g. restricted
egress), upgrading back to live data automatically when connectivity returns.
The simulator emits the *same event shapes*, so no other module can tell the
difference — including the tests.

### 2. Interest-driven streaming
The WS hub refcounts channel subscriptions and reports interest changes to
`MarketDataService`, which asks the active source to stream only what clients
need (Binance `SUBSCRIBE`/`UNSUBSCRIBE` on a single combined connection).
The simulator simply flips per-symbol interest flags. Resting orders and
TP/SL evaluation always receive **all** ticks via the engine's own
subscription.

### 3. The matching engine is the only writer of trading state
Orders fill through `executeFill()`, which runs inside a single SQLite
transaction: order status → position netting (open / increase / reduce /
flip) → realized P&L → commission → balance → ledger entries → equity
snapshot. Account events (`order`, `fill`, `position`, `position_closed`,
`balance`) are published to the owner's WS sessions after commit.

### 4. Read models are computed, not stored
`equity`, `margin`, `freeMargin`, `currentPrice`, `unrealizedPnl` are derived
on read (`AccountMetricsService`) from balance + positions + the live tick
cache — so they are always consistent with the market, and restarts need no
reconciliation.

### 5. Zero-native-dependency persistence
`node:sqlite` (built into Node ≥ 22.5) keeps the runtime a pure `node` image
with no native builds. The store is behind `TradingStore`/`AuthStore` — swap
to Postgres by reimplementing those two classes.

## Known v1 simplifications

- Margin is validated at placement; resting orders don't reserve margin.
- One price source is active at a time (no multi-venue aggregation).
- No order Amend on price/quantity (TP/SL amend only).
- Equity snapshots: on fills + every 60 s (not tick-by-tick).
- Candle cache is in-memory; only trading state is persisted.

## Scaling path

1. **Vertical** — SQLite handles the paper-trading write volume comfortably;
   the hot paths are in-memory (ticks, candles, resting orders).
2. **Horizontal** — market data fans out per process; move trading to a
   single-writer service (engine) + read replicas; move ticks/candles to
   Redis pub/sub; Postgres for stores.
3. **Real matching** — replace `executeFill` internals with a price-time
   priority order book per symbol; the REST/WS contract stays unchanged.
