/**
 * API facade selector.
 *
 * VITE_DATA_SOURCE selects the data layer:
 *   - "kryptto" (default) → kryptto backend (server/ in this monorepo)
 *   - "demo"              → original in-browser OpenCharts demo layer
 *
 * Both are wrapped in a Proxy whose fallback returns a benign async no-op for
 * any method not implemented, so leftover calls from non-terminal code
 * resolve harmlessly instead of throwing network errors.
 */
import { backendApi } from "./backend/api.ts";
import { demoApi } from "./demo/api.ts";

export const API_SOURCE: "kryptto" | "demo" =
  import.meta.env.VITE_DATA_SOURCE === "demo" ? "demo" : "kryptto";

const source = (API_SOURCE === "demo" ? demoApi : backendApi) as unknown as typeof demoApi;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// react-query rejects `undefined` query results, so resolve to null instead.
const benign = () => Promise.resolve(null);

export const api = new Proxy(source as Record<string, unknown>, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return benign;
  },
}) as typeof source & Record<string, (...args: never[]) => Promise<unknown>>;
