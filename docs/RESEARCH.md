# Frontend research & analysis — picking the right terminal for kryptto

> Question: *"Prepare the backend for the perfect frontend — we have many good
> ones on GitHub already made; research and analyse the right one for us."*
>
> Decision: **kryptto's backend targets the data contract of a professional,
> open-source, backend-agnostic trading terminal — OpenCharts-class frontends —
> with live Binance market data and a built-in paper-trading engine.**

Date of research: 2026-09-23.

---

## 1. Method

We surveyed the open-source crypto/trading frontend landscape on GitHub,
grouped candidates by product category, and scored them against what kryptto
needs from a *ready-made frontend that our backend can power*:

| # | Criterion | Why it matters |
|---|-----------|----------------|
| C1 | **Backend-agnostic data layer** | The frontend must talk to *our* API, not a vendor's. Is the data layer isolated behind a REST/WS facade? |
| C2 | **License** | MIT/Apache only. GPL or proprietary network clauses are non-starters for a product. |
| C3 | **Terminal-grade UX** | TradingView-class charting (lightweight-charts), order ticket, depth-of-market, positions/orders tables — not a marketing dashboard. |
| C4 | **Actively maintained** | Recent commits, responsive maintainer, believable path when something breaks. |
| C5 | **Auth/session model** | JWT access+refresh, account scoping — must map 1:1 onto our backend. |
| C6 | **No upstream lock-in** | Frontends hardwired to a specific exchange network can't be repointed. |

## 2. Candidates considered

| Candidate | Stars | License | Stack | Category | Verdict |
|---|---|---|---|---|---|
| **[OpenCharts](https://github.com/dylanpersonguy/OpenCharts)** | ~98 | **MIT** | React 19 + Vite + lightweight-charts + Zustand + TanStack Query + Zod | Pro trading terminal | ✅ **Recommended** |
| [crypto-trading-dashboard](https://github.com/raheel-afzal/crypto-trading-dashboard) | new | MIT | Next.js 16 + NestJS 12 + Prisma | Trading dashboard | 🥈 Strong runner-up (full-stack reference) |
| [CryptoPulse (coinpulse)](https://github.com/adrianhajdin/coinpulse) | ~148 | none | Next.js 16 + shadcn/ui + CoinGecko | Analytics dashboard | ❌ No license; analytics-only |
| [HollaEx Kit](https://github.com/hollaex/hollaex-kit) | — | Apache-2.0 (network) | React + HollaEx network | White-label exchange | ❌ Locked to HollaEx Network (C6) |
| [Freqtrade](https://github.com/freqtrade/freqtrade) / [OctoBot](https://github.com/Drakkar-Software/OctoBot) / [OpenTrader](https://github.com/Open-Trader/opentrader) | 53k+ / 4k+ / — | GPL/MIT | Python/TS bots | Trading **bots** | ❌ Backend-first products; the "frontend" is their own bot UI (C1) |
| [tradingchart](https://github.com/Alorse/tradingchart) / [tradeops](https://github.com/kylerobertschuster/tradeops) | small | mixed | Next.js | Charting apps | ❌ Binance-direct clients; no pluggable trading layer |
| TailAdmin / NextAdmin crypto dashboard templates | 10k+ | Tailwind license | React admin templates | Admin templates | ❌ Marketing dashboards, not trading terminals (C3) |

## 3. Analysis

### 3.1 OpenCharts — the recommendation (C1–C6: pass)

OpenCharts is a self-contained, professional-grade trading terminal: candlestick
charting with a full drawing toolkit, indicators, a depth-of-market ladder, an
order ticket, and a paper-trading engine — rendered with TradingView's own
open-source `lightweight-charts`.

The decisive property is architectural, quoted from its README:

> *"A **reference terminal UI** you can point at your own market-data and
> trading backend — the data layer is isolated behind two modules."*

Concretely, the repo ships:

- `src/services/api.ts` — a REST facade (`request()` wrapper with token refresh,
  `{error:{message, code}}` envelope, `VITE_API_URL` base URL)
- `src/services/ws.ts` — a streaming client with the surface
  `connect(token) / subscribe(channel, handler) / subscribeAccounts(ids) /
  setSymbolInterest(symbols) / reauthenticate(token) / onStateChange(cb)`
- `src/services/schemas.ts` — **Zod schemas for the whole domain**: `User`,
  `AuthResponse`, `Account`, `AccountStats`, `LedgerEntry`, `EquityPoint`,
  `Order`, `Position`, `Fill`, `ClosedPosition`, `MarketDataSymbol`,
  `MarketDataCandlesPayload` …

That is a published, typed **backend contract** — the terminal is *designed*
to be repointed at a different backend by implementing the facade. MIT-licensed
and updated within the last week at research time (2026-09-16).

### 3.2 crypto-trading-dashboard — runner-up

A polished Next.js 16 + NestJS + Prisma paper-trading dashboard (live WS
prices, optimistic order execution, portfolio). Excellent **full-stack
reference** — its API design (`POST /api/auth/login`, `GET /api/coins`,
`GET /api/portfolio`, `POST /api/orders`, `ws://…/ws` snapshot-then-stream)
validates the same contract we implemented. Not chosen as the target because
it's a smaller portfolio dashboard rather than a pro terminal (weaker on C3),
and it's brand new with no community track record yet (weaker on C4).

### 3.3 Why not the rest

- **HollaEx Kit** — the closest "full exchange" option, but the web app expects
  the HollaEx *network* server for trading and blockchain functionality; it
  cannot simply be pointed at a third-party API (fails C1/C6).
- **Freqtrade / OctoBot / OpenTrader** — trading *bots* whose UIs visualize the
  bot's own engine. Great products, wrong shape: we'd be adopting their
  backend, not powering their frontend.
- **CryptoPulse** — beautiful CoinGecko analytics dashboard, but read-only
  (no trading), and **ships no license** → legally unusable (C2).
- **Admin templates (TailAdmin etc.)** — presentation templates with charts,
  not terminals; no order/position/depth concepts (C3).

## 4. What the chosen contract requires from a backend

Extracted from OpenCharts' data layer (see `server/src/domain/types.ts`, which
mirrors these schemas 1:1):

1. **Auth** — `POST /auth/login|register|demo|refresh|logout` returning
   `{accessToken, refreshToken, user}`; user: `{id, email, firstName,
   lastName, roles, status, createdAt}`.
2. **Market data REST** — `/market-data/symbols` (contract metadata: tickSize,
   contractSize, digits, commission…), `/market-data/ticks`,
   `/market-data/candles?symbol&timeframe` → `{candles[], metadata}`.
3. **Accounts** — `/accounts/me/list`, `/accounts/:id`, `/accounts` (create),
   with `{balance, equity, margin, freeMargin, template{…}}`, plus
   `/ledger`, `/equity-curve`, `/stats` (winRate, profitFactor, maxDrawdown…).
4. **Trading** — orders (`MARKET|LIMIT|STOP`, TP/SL, cancel/amend), netted
   positions (`LONG|SHORT`, `unrealizedPnl`), fills (`commission`,
   `realizedPnl`), closed positions.
5. **WebSocket** — channel subscription with symbol interest gating and
   authenticated account-event streams.

**Every one of these is implemented in this repository** — see
[docs/API.md](API.md) and [docs/INTEGRATION.md](INTEGRATION.md).

## 5. Decision record

| Decision | Choice | Rationale |
|---|---|---|
| Target frontend class | Pro trading terminal (OpenCharts) | Only category whose frontends are deliberately backend-agnostic |
| Backend stack | NestJS 12 + TypeScript | Matches the frontend ecosystem; shared types; first-class WebSocket + OpenAPI support |
| Market data | Binance public REST+WS, auto-fallback to a built-in simulator | No API key needed; the platform must always boot, even air-gapped |
| Persistence | SQLite via `node:sqlite` | Zero native dependencies, single-file ops, trivially swappable for Postgres later |
| API style | REST under `/api` + plain `ws` channels | Exactly what the OpenCharts `request()`/`wsClient` surface expects |

**Next step** (when we move to the frontend phase): clone OpenCharts, delete
`src/services/demo/*`, and implement `api.ts` + `ws.ts` against kryptto's
endpoints — the integration guide ([docs/INTEGRATION.md](INTEGRATION.md))
contains drop-in code for both.
