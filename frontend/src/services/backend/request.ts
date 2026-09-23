/**
 * HTTP client for the kryptto backend (server/ in this monorepo).
 *
 * Mirrors the OpenCharts error contract: failures throw an ApiError carrying
 * `{ error: { code, message } }` (plus flat `code`/`message`) so existing UI
 * error handlers work unchanged.
 *
 * Base URL resolution:
 *   - VITE_API_URL set (e.g. "http://localhost:8080") → direct: `${VITE_API_URL}/api`
 *   - unset → same-origin "/api" (the Vite dev server proxies to the backend)
 */

export const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, "")}/api`
  : "/api";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  /** OpenCharts-compatible nested envelope. */
  error: { code: string; message: string };

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.error = { code, message };
  }
}

// ── Single-flight token refresh ──────────────────────────
// Concurrent 401s (e.g. burst of queries after reconnect) must not trigger
// parallel /auth/refresh calls — the second would reuse an already-rotated
// refresh token and force a logout.
let refreshInFlight: Promise<boolean> | null = null;

async function tryTokenRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const rt = localStorage.getItem("refresh_token");
    if (!rt) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const json = (await res.json().catch(() => null)) as
        | { accessToken?: string; refreshToken?: string }
        | null;
      if (!json?.accessToken) return false;
      localStorage.setItem("access_token", json.accessToken);
      if (json.refreshToken) localStorage.setItem("refresh_token", json.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const applyAuth = () => {
    const token = localStorage.getItem("access_token");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    else headers.delete("Authorization");
  };

  const doFetch = (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

  applyAuth();
  let res: Response;
  try {
    res = await doFetch();
  } catch (error) {
    // Network/timeout — surface as a typed offline error so toasts stay clean.
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      error instanceof Error && error.name === "TimeoutError"
        ? "Request timed out"
        : "Cannot reach the kryptto backend",
    );
  }

  if (res.status === 401 && !path.startsWith("/auth/")) {
    const refreshed = await tryTokenRefresh();
    if (refreshed) {
      applyAuth();
      res = await doFetch();
    }
  }

  if (res.status === 204) return undefined as T;

  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
    | null;

  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `HTTP ${res.status}`,
      err?.details,
    );
  }
  return json as T;
}
