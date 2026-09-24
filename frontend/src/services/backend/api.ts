/**
 * kryptto backend implementation of the OpenCharts API facade.
 *
 * Every method matches the signature the terminal already calls (see
 * services/demo/api.ts for the in-browser reference). Methods NOT defined
 * here fall through to the benign no-op Proxy in services/api.ts, exactly
 * like unimplemented demo methods do.
 *
 * Field mapping notes:
 *  - kryptto serves candle `time` in epoch MILLISECONDS; OpenCharts (and
 *    lightweight-charts) use SECONDS — converted in mapCandles().
 *  - PlaceOrderInput.symbol → kryptto orders use symbolName.
 *  - All domain shapes (User, Account, Order, Position, Fill, ClosedPosition,
 *    LedgerEntry, EquityPoint, Symbol) are field-compatible 1:1 with kryptto.
 */
import type { DrawingLine } from "../../pages/trading/constants.ts";
import type {
  Account,
  AccountStats,
  Candle,
  ClosedPosition,
  EquityPoint,
  Fill,
  LedgerEntry,
  Order,
  Position,
  Symbol,
  User,
} from "../schemas.ts";
import { ApiError, request } from "./request.ts";

// ── local types ──────────────────────────────────────────

interface KrypttoCandle {
  time: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed?: boolean;
}

interface KrypttoCandlesResponse {
  candles: KrypttoCandle[];
  metadata: { historicalCoverageStart: number | null; isPartial: boolean; backfillQueued: boolean };
}

interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface PlaceOrderInput {
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
}

interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  user: User;
}

// ── mappers ──────────────────────────────────────────────

function toCandle(row: KrypttoCandle): Candle {
  return {
    time: Math.floor(row.time / 1000), // lightweight-charts uses seconds
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    timestamp: row.time,
  };
}

function mapCandles(res: KrypttoCandlesResponse) {
  return {
    candles: res.candles.map(toCandle),
    metadata: {
      historicalCoverageStart:
        res.metadata.historicalCoverageStart != null
          ? Math.floor(res.metadata.historicalCoverageStart / 1000)
          : null,
      // kryptto history is always complete; the forming last bar is normal.
      isPartial: false,
      backfillQueued: false,
    },
  };
}

function withTotalPages<T>(res: Paginated<T>) {
  return {
    ...res,
    totalPages: res.pageSize > 0 ? Math.ceil(res.total / res.pageSize) : 0,
  };
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

// ── chart drawings (localStorage — same as demo mode) ─────

const DRAW_KEY = (symbol: string) => `oc_drawings_${symbol}`;

function readDrawings(symbol: string): DrawingLine[] {
  try {
    return JSON.parse(localStorage.getItem(DRAW_KEY(symbol)) ?? "[]") as DrawingLine[];
  } catch {
    return [];
  }
}

function writeDrawings(symbol: string, list: DrawingLine[]): void {
  localStorage.setItem(DRAW_KEY(symbol), JSON.stringify(list));
}

const chartDrawings = {
  list: (symbol: string) => Promise.resolve(readDrawings(symbol)),
  save: (symbol: string, _tf: string, drawing: DrawingLine) => {
    const list = readDrawings(symbol).filter((d) => d.id !== drawing.id);
    list.push(drawing);
    writeDrawings(symbol, list);
    return Promise.resolve({ saved: true });
  },
  remove: (drawingId: string) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("oc_drawings_")) {
        const symbol = key.slice("oc_drawings_".length);
        writeDrawings(symbol, readDrawings(symbol).filter((d) => d.id !== drawingId));
      }
    }
    return Promise.resolve({ deleted: true });
  },
  clear: (symbol: string) => {
    writeDrawings(symbol, []);
    return Promise.resolve({ cleared: true });
  },
};

// ── helpers ──────────────────────────────────────────────

async function activeAccountId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const stored = localStorage.getItem("active_account");
  if (stored) return stored;
  const accounts = await request<Account[]>("/accounts/me/list");
  if (!accounts || accounts.length === 0) {
    throw new ApiError(404, "NO_ACCOUNT", "No trading account available");
  }
  return accounts[0]!.id;
}

// ── the facade ───────────────────────────────────────────

export const backendApi = {
  // ── Auth ──
  login: (email: string, password: string) =>
    request<AuthPayload>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  demoLogin: () =>
    request<AuthPayload>("/auth/demo", {
      method: "POST",
    }),

  register: (input: { email: string; password: string; firstName: string; lastName: string }) =>
    request<AuthPayload>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  completeMfaLogin: () => {
    // kryptto never returns mfaRequired, so this path is unreachable.
    return Promise.reject(new ApiError(400, "MFA_UNSUPPORTED", "MFA is not enabled on kryptto"));
  },

  logout: (refreshToken?: string) => {
    if (!refreshToken) return Promise.resolve({ success: true });
    return request<{ success: boolean }>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  },

  refreshToken: (refreshToken: string) =>
    request<{ accessToken: string; refreshToken: string }>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    }),

  getMyProfile: () => request<User>("/auth/me"),
  getMe: () => request<User>("/auth/me"),

  changePassword: (_currentPassword: string, _newPassword: string) =>
    Promise.reject(
      new ApiError(501, "UNSUPPORTED", "Password change is not enabled on this backend"),
    ),

  // ── Accounts ──
  getMyAccounts: () => request<Account[]>("/accounts/me/list"),

  getAccount: (id: string) => request<Account>(`/accounts/${id}`),

  getEquityHistory: (id: string) =>
    request<EquityPoint[]>(`/accounts/${id}/equity-curve`) as Promise<EquityPoint[]>,

  getLedger: (id: string, page = 1, pageSize = 50) =>
    request<Paginated<LedgerEntry>>(`/accounts/${id}/ledger${qs({ page, pageSize })}`).then(
      withTotalPages,
    ),

  getAccountStats: (id: string) => request<AccountStats>(`/accounts/${id}/stats`),

  setAccountLabel: (_accountId: string, _label: string) => Promise.resolve({ success: true }),

  getAccountMetrics: (id: string) =>
    request<Account>(`/accounts/${id}`).then((account) => ({
      accountId: account.id,
      equity: account.equity,
      balance: account.balance,
      freeMargin: account.freeMargin,
      marginUsed: account.margin,
      floatingPnl: account.equity - account.balance,
      dailyPnl: 0,
      ddDaily: null,
      ddDailyMax: null,
      ddTotal: null,
      ddTotalMax: null,
      ddTrailing: null,
      ddTrailingMax: null,
      trailingDrawdownFloor: null,
      trailingDrawdownPeak: null,
      trailingDrawdownMode: null,
      trailingDrawdownTrailMode: null,
      trailingDrawdownFloorLocked: false,
      trailingDrawdownTrailToBreakeven: false,
      profitTargetPercent: null,
      profitTargetProgress: 0,
      minTradingDays: null,
      tradingDaysCompleted: 0,
      minDaysProgress: 0,
      status: account.status,
      phase: account.phase,
      highWaterMark: account.balance,
      startingBalance: account.template?.startingBalance ?? account.balance,
      currency: "USD",
      lastMarkTs: account.updatedAt,
    })),

  // ── Symbols & market data ──
  getSymbols: () => request<Symbol[]>("/market-data/symbols"),

  getCandles: (
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { fromMs: number; toMs: number },
  ) =>
    request<KrypttoCandlesResponse>(
      `/market-data/candles${qs({ symbol, timeframe, limit, fromMs: range?.fromMs, toMs: range?.toMs })}`,
    ).then((res) => mapCandles(res).candles),

  getCandlesWithMeta: (symbol: string, timeframe: string, limit?: number) =>
    request<KrypttoCandlesResponse>(
      `/market-data/candles${qs({ symbol, timeframe, limit })}`,
    ).then(mapCandles),

  getTick: (symbol: string) =>
    request<{ symbol: string; bid: number; ask: number; last: number; timestamp: number }>(
      `/market-data/ticks/${symbol}`,
    ),

  getMarketDataHealth: () =>
    request<{
      service: string;
      marketData: {
        mode: string;
        healthy: boolean;
        symbols: number;
        lastTickAt: string | null;
        note?: string;
      };
    }>("/status").then((status) => ({
      adapter: {
        status: status.marketData.healthy ? "ok" : "unavailable",
        reason: status.marketData.note ?? status.marketData.mode,
      },
      staleCount: 0,
      totalSymbols: status.marketData.symbols,
      lastTickAgeMs: status.marketData.lastTickAt
        ? Date.now() - Date.parse(status.marketData.lastTickAt)
        : -1,
    })),

  getEconomicCalendar: (..._args: unknown[]) => Promise.resolve([]),

  // ── Trading ──
  placeOrder: (input: PlaceOrderInput) => {
    if (input.type === "STOP_LIMIT") {
      return Promise.reject(
        new ApiError(400, "UNSUPPORTED_ORDER_TYPE", "STOP_LIMIT orders are not supported"),
      );
    }
    return request<Order>("/orders", {
      method: "POST",
      body: JSON.stringify({
        accountId: input.accountId,
        symbolName: input.symbol,
        side: input.side,
        type: input.type,
        quantity: input.quantity,
        price: input.price,
        stopPrice: input.stopPrice,
        takeProfit: input.takeProfit,
        stopLoss: input.stopLoss,
      }),
    });
  },

  cancelOrder: (orderId: string) =>
    request<Order>(`/orders/${orderId}`, { method: "DELETE" }),

  modifyOrder: (
    orderId: string,
    modifications: { takeProfit?: number | null; stopLoss?: number | null },
  ) =>
    request<Order>(`/orders/${orderId}`, {
      method: "PATCH",
      // undefined fields are dropped by JSON.stringify; null clears server-side.
      body: JSON.stringify({
        takeProfit: modifications.takeProfit,
        stopLoss: modifications.stopLoss,
      }),
    }),

  cancelAllOrders: async (accountId?: string) => {
    const id = await activeAccountId(accountId);
    const orders = await request<Paginated<Order>>(
      `/accounts/${id}/orders${qs({ status: "OPEN", pageSize: 200 })}`,
    );
    for (const order of orders.data) {
      await request(`/orders/${order.id}`, { method: "DELETE" }).catch(() => undefined);
    }
    return { success: true, cancelled: orders.data.length };
  },

  getOrders: (accountId: string, status?: string) =>
    request<Paginated<Order>>(
      `/accounts/${accountId}/orders${qs({ status, pageSize: 200 })}`,
    ).then((res) => res.data),

  getPositions: (accountId: string) => request<Position[]>(`/accounts/${accountId}/positions`),

  getOpenPositionCount: async () => {
    const accounts = await request<Account[]>("/accounts/me/list");
    let count = 0;
    for (const account of accounts ?? []) {
      const positions = await request<Position[]>(`/accounts/${account.id}/positions`).catch(
        () => [] as Position[],
      );
      count += positions.length;
    }
    return count;
  },

  closePosition: (positionId: string, quantity?: number) =>
    request<Order>(`/positions/${positionId}/close`, {
      method: "POST",
      body: JSON.stringify(quantity !== undefined ? { quantity } : {}),
    }),

  closeAllPositions: async (accountId: string) => {
    const positions = await request<Position[]>(`/accounts/${accountId}/positions`);
    for (const position of positions) {
      await request(`/positions/${position.id}/close`, {
        method: "POST",
        body: JSON.stringify({}),
      }).catch(() => undefined);
    }
    return { success: true, closed: positions.length };
  },

  modifyPosition: (
    positionId: string,
    modifications: { takeProfit?: number | null; stopLoss?: number | null },
  ) =>
    request<Position>(`/positions/${positionId}`, {
      method: "PATCH",
      // undefined fields are dropped by JSON.stringify; null clears server-side.
      body: JSON.stringify({
        takeProfit: modifications.takeProfit,
        stopLoss: modifications.stopLoss,
      }),
    }),

  getFills: (accountId: string, page = 1, pageSize = 50) =>
    request<Paginated<Fill>>(`/accounts/${accountId}/fills${qs({ page, pageSize })}`).then(
      withTotalPages,
    ),

  getClosedPositions: (accountId: string, page = 1, pageSize = 50) =>
    request<ClosedPosition[]>(`/accounts/${accountId}/closed-positions`).then((all) => {
      const start = (page - 1) * pageSize;
      const data = all.slice(start, start + pageSize);
      return {
        data,
        total: all.length,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
      };
    }),

  getClosedPositionsSummary: (accountId: string, from?: string | null, to?: string | null) =>
    request<ClosedPosition[]>(`/accounts/${accountId}/closed-positions`).then((all) => {
      const fromMs = from ? Date.parse(from) : null;
      const toMs = to ? Date.parse(to) : null;
      const rows = all.filter((row) => {
        const closedMs = row.closedAt ? Date.parse(row.closedAt) : null;
        if (closedMs == null) return true;
        if (fromMs != null && closedMs < fromMs) return false;
        if (toMs != null && closedMs > toMs) return false;
        return true;
      });
      return {
        pnl: rows.reduce((sum, row) => sum + row.realizedPnl, 0),
        commission: rows.reduce((sum, row) => sum + row.commission, 0),
        swap: rows.reduce((sum, row) => sum + row.swap, 0),
        tradeCount: rows.length,
      };
    }),

  getFillQuality: (_accountId: string) => Promise.resolve([]),

  // ── Trade journal (not backend-backed yet; empty like demo) ──
  getJournalEntries: () => Promise.resolve([]),
  createJournalEntry: () => Promise.resolve(null),
  updateJournalEntry: () => Promise.resolve(null),
  deleteJournalEntry: () => Promise.resolve({ success: true }),

  // ── Chart persistence (localStorage — same as demo) ──
  chartDrawings,
  savePreferences: () => Promise.resolve({ success: true }),

  // ── Feature gating / misc ──
  getFeatureFlags: () => Promise.resolve({}),
  isAiTraderEnabled: () => Promise.resolve(false),
  getAnnouncements: () => Promise.resolve([]),
  getAnnouncementsUnreadCount: () => Promise.resolve(0),
  replayGetSession: () => Promise.resolve(null),
};
