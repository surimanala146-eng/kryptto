/**
 * WebSocket client selector.
 *
 * VITE_DATA_SOURCE selects the implementation (see services/api.ts):
 *   - "kryptto" (default) → KrypttoWsClient talking to the kryptto backend
 *   - "demo"              → in-browser demo client (upstream OpenCharts)
 */
import { DemoWsClient } from "./demo/ws-client.ts";
import { KrypttoWsClient } from "./backend/ws.ts";
import type { ConnectionState, WsClient, WsHandler } from "./ws-types.ts";

export type { ConnectionState, WsHandler };

const client: WsClient =
  import.meta.env.VITE_DATA_SOURCE === "demo" ? new DemoWsClient() : new KrypttoWsClient();

export const wsClient = client;
