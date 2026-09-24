import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';
import WebSocket, { WebSocketServer } from 'ws';

export type ClientOp =
  | { op: 'subscribe'; channel: string }
  | { op: 'unsubscribe'; channel: string }
  | { op: 'auth'; token: string }
  | { op: 'ping' };

interface Session {
  id: string;
  socket: WebSocket;
  userId: string | null;
  email: string | null;
  subscriptions: Set<string>;
  alive: boolean;
}

/** Channels a client may subscribe to. */
const CHANNEL_PATTERN =
  /^(ticks|ticks:[A-Z0-9]+|candles:[A-Z0-9]+:(1m|5m|15m|30m|1h|4h|1d|1w)|orderbook:[A-Z0-9]+|trades:[A-Z0-9]+|stats:[A-Z0-9]+|account|status)$/;

/**
 * Channel-based realtime hub over a plain `ws` server (no socket.io protocol
 * lock-in). Frame protocol — documented in docs/INTEGRATION.md:
 *
 *   client → server : {"op":"subscribe","channel":"candles:BTCUSDT:1m"}
 *                     {"op":"unsubscribe","channel":...}
 *                     {"op":"auth","token":"<jwt>"}
 *                     {"op":"ping"}
 *   server → client : {"channel":"candles:BTCUSDT:1m","event":{...candle...}}
 *                     {"type":"subscribed"|"unsubscribed"|"authenticated"|
 *                      "error"|"pong", ...}
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private wss: WebSocketServer | null = null;
  private readonly sessions = new Map<string, Session>();
  private heartbeat: NodeJS.Timeout | null = null;

  /** Refcount per channel, recomputed as sessions come and go. */
  private readonly channelCounts = new Map<string, number>();
  private readonly interestHandlers = new Set<(channels: Set<string>) => void>();

  constructor(private readonly jwt: JwtService) {}

  /**
   * Attach the WebSocket endpoint at /ws on an existing HTTP server.
   * Token may be provided as ?token= (browsers cannot set WS headers).
   */
  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') ?? undefined;

      void (async () => {
        let userId: string | null = null;
        let email: string | null = null;
        if (token) {
          try {
            const payload = this.jwt.verify<JwtPayload>(token);
            if (payload.type === 'access') {
              userId = payload.sub;
              email = payload.email;
            }
          } catch {
            // invalid token → anonymous session; they can still subscribe to
            // public channels or authenticate later with an `auth` op.
          }
        }
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.register(ws, userId, email);
        });
      })();
    });

    this.heartbeat = setInterval(() => this.pingSweep(), 30_000);
    this.logger.log('Realtime hub attached at /ws');
  }

  private register(socket: WebSocket, userId: string | null, email: string | null): void {
    const id = `s_${Math.random().toString(36).slice(2, 10)}`;
    const session: Session = { id, socket, userId, email, subscriptions: new Set(), alive: true };
    this.sessions.set(id, session);

    socket.on('pong', () => {
      session.alive = true;
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString()) as ClientOp;
        this.handleOp(session, parsed);
      } catch {
        this.send(session, { type: 'error', message: 'Invalid JSON frame' });
      }
    });

    socket.on('close', () => this.drop(session));
    socket.on('error', () => this.drop(session));

    this.send(session, {
      type: 'hello',
      authenticated: session.userId !== null,
      subscriptions: [...session.subscriptions],
    });
    if (session.userId) this.subscribe(session, 'account', true);
  }

  private handleOp(session: Session, op: ClientOp): void {
    switch (op?.op) {
      case 'ping':
        this.send(session, { type: 'pong', timestamp: Date.now() });
        return;
      case 'subscribe':
        this.subscribe(session, op.channel);
        return;
      case 'unsubscribe':
        this.unsubscribe(session, op.channel);
        return;
      case 'auth': {
        try {
          const payload = this.jwt.verify<JwtPayload>(op.token);
          if (payload.type !== 'access') throw new Error('wrong token type');
          session.userId = payload.sub;
          session.email = payload.email;
          this.subscribe(session, 'account', true);
          this.send(session, { type: 'authenticated', userId: payload.sub, email: payload.email });
        } catch {
          this.send(session, { type: 'error', message: 'Invalid or expired token' });
        }
        return;
      }
      default:
        this.send(session, { type: 'error', message: 'Unknown op' });
    }
  }

  private subscribe(session: Session, channel: string, quiet = false): void {
    if (!CHANNEL_PATTERN.test(channel)) {
      this.send(session, { type: 'error', message: `Unknown channel "${channel}"` });
      return;
    }
    if (channel === 'account' && !session.userId) {
      this.send(session, { type: 'error', message: 'Channel "account" requires authentication' });
      return;
    }
    if (!session.subscriptions.has(channel)) {
      session.subscriptions.add(channel);
      this.bump(channel, 1);
    }
    if (!quiet) this.send(session, { type: 'subscribed', channel });
  }

  private unsubscribe(session: Session, channel: string): void {
    if (session.subscriptions.delete(channel)) {
      this.bump(channel, -1);
    }
    this.send(session, { type: 'unsubscribed', channel });
  }

  private bump(channel: string, delta: number): void {
    const next = (this.channelCounts.get(channel) ?? 0) + delta;
    if (next <= 0) this.channelCounts.delete(channel);
    else this.channelCounts.set(channel, next);
    const active = new Set(this.channelCounts.keys());
    for (const handler of this.interestHandlers) handler(active);
  }

  private drop(session: Session): void {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    for (const channel of session.subscriptions) this.bump(channel, -1);
  }

  private pingSweep(): void {
    for (const session of this.sessions.values()) {
      if (!session.alive) {
        session.socket.terminate();
        this.drop(session);
        continue;
      }
      session.alive = false;
      try {
        session.socket.ping();
      } catch {
        this.drop(session);
      }
    }
  }

  private send(session: Session, payload: unknown): void {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(payload));
    }
  }

  // ── public API for other modules ────────────────────────────────────────

  /**
   * Publish an event on a channel. For the `account` channel an extra filter
   * decides which authenticated sessions receive it (user scoping).
   */
  publish(
    channel: string,
    event: unknown,
    filter?: (session: Session) => boolean,
  ): void {
    const frame = JSON.stringify({ channel, event });
    for (const session of this.sessions.values()) {
      if (!session.subscriptions.has(channel)) continue;
      if (filter && !filter(session)) continue;
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(frame);
      }
    }
  }

  /** Publish an account-scoped event to its owner's sessions only. */
  publishToUser(userId: string, channel: string, event: unknown): void {
    this.publish(channel, event, (session) => session.userId === userId);
  }

  /** Fire-and-forget push to every subscriber of a channel (used for snapshots). */
  publishImmediate(userId: string | null, channel: string, event: unknown): void {
    this.publish(channel, event, (session) => (userId ? session.userId === userId : true));
  }

  onInterestChange(handler: (channels: Set<string>) => void): () => void {
    this.interestHandlers.add(handler);
    handler(new Set(this.channelCounts.keys()));
    return () => this.interestHandlers.delete(handler);
  }

  clientCount(): number {
    return this.sessions.size;
  }

  shutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const session of this.sessions.values()) {
      session.socket.close(1001, 'server shutdown');
    }
    this.sessions.clear();
    this.wss?.close();
    this.wss = null;
  }
}
