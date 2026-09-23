/** Typed application configuration, loaded once from the environment. */

export type MarketDataMode = 'auto' | 'live' | 'simulated';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  corsOrigins: string[] | '*';
  servePreview: boolean;
  databasePath: string;

  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string; // e.g. "15m"
    refreshTtlSeconds: number;
  };

  marketData: {
    mode: MarketDataMode;
    binanceRestUrl: string;
    binanceWsUrl: string;
    maxSymbols: number;
    simulatorTickIntervalMs: number;
    candleHistoryDepth: number;
  };
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseTtlSeconds(value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const match = /^(\d+)(s|m|h|d)?$/.exec(raw);
  if (!match) return fallback;
  const amount = Number.parseInt(match[1], 10);
  switch (match[2]) {
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86400;
    default:
      return amount;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const corsRaw = env.CORS_ORIGINS ?? '*';
  const corsOrigins: string[] | '*' =
    corsRaw.trim() === '*' ? '*' : corsRaw.split(',').map((o) => o.trim()).filter(Boolean);

  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env'];

  return {
    env: nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 8080),
    corsOrigins,
    servePreview: (env.SERVE_PREVIEW ?? 'true').toLowerCase() !== 'false',
    databasePath: env.DATABASE_PATH ?? 'data/kryptto.db',

    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
      refreshSecret: env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
      accessTtl: env.JWT_ACCESS_TTL ?? '15m',
      refreshTtlSeconds: parseTtlSeconds(env.JWT_REFRESH_TTL, 7 * 24 * 3600),
    },

    marketData: {
      mode: (env.MARKET_DATA_MODE as MarketDataMode) ?? 'auto',
      binanceRestUrl: env.BINANCE_REST_URL ?? 'https://api.binance.com',
      binanceWsUrl: env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443/stream',
      maxSymbols: int(env.BINANCE_MAX_SYMBOLS, 120),
      simulatorTickIntervalMs: int(env.SIMULATOR_TICK_INTERVAL_MS, 750),
      candleHistoryDepth: int(env.CANDLE_HISTORY_DEPTH, 1000),
    },
  };
}

export const CONFIG = Symbol('APP_CONFIG');
