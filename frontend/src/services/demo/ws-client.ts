import { publish, subscribeChannel, type ChannelHandler } from "./bus.ts";
import { startDemoFeed, stopDemoFeed } from "./feed.ts";
import type { ConnectionState, WsClient, WsHandler } from "../ws-types.ts";

/**
 * Demo WebSocket client (upstream OpenCharts behavior, unchanged).
 *
 * OpenCharts runs without a backend: all real data the terminal needs is
 * served by the in-browser demo layer (services/demo). This replaces the real
 * reconnecting WebSocket with an in-process client backed by the demo event
 * bus + feed (services/demo). It exposes the public surface defined in
 * services/ws-types.ts so no consumer had to change.
 */
export class DemoWsClient implements WsClient {
  private _state: ConnectionState = "disconnected";
  private stateListeners = new Set<(s: ConnectionState) => void>();

  get state(): ConnectionState {
    return this._state;
  }

  private setState(next: ConnectionState): void {
    this._state = next;
    for (const cb of this.stateListeners) cb(next);
  }

  connect(_token?: string): void {
    this.setState("connecting");
    startDemoFeed();
    // Resolve to connected on the next tick so onStateChange subscribers
    // registered synchronously after connect() still receive the transition.
    setTimeout(() => this.setState("connected"), 0);
  }

  disconnect(): void {
    stopDemoFeed();
    this.setState("disconnected");
  }

  reauthenticate(_token: string): void {
    // No auth in demo mode — nothing to refresh.
  }

  subscribe(channel: string, handler: WsHandler): () => void {
    return subscribeChannel(channel, handler as ChannelHandler);
  }

  subscribeAccounts(_accountIds: string[]): void {
    // All account events already flow through the "account" channel.
  }

  setSymbolInterest(_symbols: string[]): void {
    // The demo feed streams every symbol; nothing to gate.
  }

  setChartStream(_symbol: string, _timeframe: string): void {
    // Demo mode aggregates candles in-browser from the replayed tick feed.
  }

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this._state);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Allow the engine/feed to push events through the same client (parity helper). */
  emit(channel: string, event: unknown): void {
    publish(channel, event);
  }
}
