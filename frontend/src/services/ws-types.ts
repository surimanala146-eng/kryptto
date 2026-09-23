/**
 * Shared WebSocket client surface consumed by the terminal (stores, bridges,
 * TradingPage). Implemented twice:
 *   - services/demo/ws-client.ts  — in-browser demo backend
 *   - services/backend/ws.ts      — kryptto backend (this fork's default)
 */

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected";

export type WsHandler = (event: unknown) => void;

export interface WsClient {
  readonly state: ConnectionState;
  connect(token?: string): void;
  disconnect(): void;
  reauthenticate(token: string): void;
  subscribe(channel: string, handler: WsHandler): () => void;
  subscribeAccounts(accountIds: string[]): void;
  setSymbolInterest(symbols: string[]): void;
  /** Focus server-aggregated candle streaming (no-op in demo mode). */
  setChartStream(symbol: string, timeframe: string): void;
  onStateChange(cb: (s: ConnectionState) => void): () => void;
}
