import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/global-exception.filter';
import { RealtimeService } from '../src/realtime/realtime.service';

/**
 * Full-stack e2e: auth → market data → trading → websocket, against an
 * in-memory database and the simulated market (zero external dependencies).
 */

process.env.DATABASE_PATH = ':memory:';
process.env.MARKET_DATA_MODE = 'simulated';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

describe('kryptto API (e2e)', () => {
  let app: INestApplication;
  let httpServer: any;
  let token: string;
  let accountId: string;
  let wsUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new GlobalExceptionFilter(app.get(HttpAdapterHost)));
    await app.init();
    httpServer = app.getHttpServer();
    await app.listen(0);
    const port = (httpServer.address() as { port: number }).port;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    // the e2e owns the raw server, so attach the realtime hub like main.ts does
    app.get(RealtimeService).attach(httpServer);

    // wait for the market to be ready AND for the first tick to arrive
    const deadline = Date.now() + 15_000;
    for (;;) {
      const tick = await request(httpServer).get('/api/market-data/ticks/BTCUSDT');
      if (tick.status === 200) break;
      if (Date.now() > deadline) throw new Error('market data did not start');
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it('reports status with the simulated market', async () => {
    const res = await request(httpServer).get('/api/status').expect(200);
    expect(res.body.service).toBe('kryptto-api');
    expect(res.body.marketData.mode).toBe('simulated');
    expect(res.body.marketData.symbols).toBeGreaterThan(0);
  });

  it('registers a user and provisions a paper account', async () => {
    const res = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'trader@example.com', password: 'sup3rsecret', firstName: 'Test' })
      .expect(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.email).toBe('trader@example.com');
    token = res.body.accessToken;

    const accounts = await request(httpServer)
      .get('/api/accounts/me/list')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(accounts.body.length).toBe(1);
    expect(accounts.body[0].balance).toBe(100_000);
    expect(accounts.body[0].leverage).toBe(10);
    accountId = accounts.body[0].id;
  });

  it('rejects duplicate registration with 409', async () => {
    const res = await request(httpServer)
      .post('/api/auth/register')
      .send({ email: 'trader@example.com', password: 'sup3rsecret' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('logs in and rotates refresh tokens', async () => {
    const login = await request(httpServer)
      .post('/api/auth/login')
      .send({ email: 'trader@example.com', password: 'sup3rsecret' })
      .expect(201);
    expect(login.body.accessToken).toBeDefined();

    const refresh = await request(httpServer)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(201);
    expect(refresh.body.refreshToken).not.toBe(login.body.refreshToken);

    // rotation revokes the old token
    await request(httpServer)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });

  it('serves the symbol registry, ticks and candles', async () => {
    const symbols = await request(httpServer).get('/api/market-data/symbols').expect(200);
    expect(symbols.body.length).toBeGreaterThan(10);
    expect(symbols.body[0].tickSize).toBeGreaterThan(0);

    const ticks = await request(httpServer).get('/api/market-data/ticks').expect(200);
    expect(ticks.body.BTCUSDT.bid).toBeGreaterThan(0);

    const tick = await request(httpServer).get('/api/market-data/ticks/BTCUSDT').expect(200);
    expect(tick.body.ask).toBeGreaterThan(tick.body.bid);

    const candles = await request(httpServer)
      .get('/api/market-data/candles?symbol=BTCUSDT&timeframe=1m&limit=50')
      .expect(200);
    expect(candles.body.candles.length).toBe(50);
    expect(candles.body.metadata.isPartial).toBe(true);
    const bars = candles.body.candles;
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].time - bars[i - 1].time).toBe(60_000);
    }
  });

  it('rejects unknown symbols with a typed 404', async () => {
    const res = await request(httpServer).get('/api/market-data/ticks/NOPEUSDT').expect(404);
    expect(res.body.error.code).toBe('SYMBOL_NOT_FOUND');
  });

  it('requires auth for trading routes', async () => {
    await request(httpServer).get('/api/accounts/me/list').expect(401);
    const res = await request(httpServer).get('/api/accounts/me/list').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('fills a market order and books the position, commission and ledger', async () => {
    const tickBefore = (await request(httpServer).get('/api/market-data/ticks/BTCUSDT').expect(200))
      .body;

    const order = await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.25 })
      .expect(201);
    expect(order.body.status).toBe('FILLED');
    expect(order.body.avgFillPrice).toBe(tickBefore.ask);

    const positions = await request(httpServer)
      .get(`/api/accounts/${accountId}/positions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(positions.body.length).toBe(1);
    const position = positions.body[0];
    expect(position.symbolName).toBe('BTCUSDT');
    expect(position.side).toBe('LONG');
    expect(position.quantity).toBe(0.25);
    expect(position.entryPrice).toBe(tickBefore.ask);

    const account = await request(httpServer)
      .get(`/api/accounts/${accountId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const expectedCommission = 0.25 * tickBefore.ask * 0.0005;
    expect(account.body.balance).toBeCloseTo(100_000 - expectedCommission, 6);
    expect(account.body.margin).toBeGreaterThan(0);
    expect(account.body.freeMargin).toBeGreaterThan(0);

    const ledger = await request(httpServer)
      .get(`/api/accounts/${accountId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(ledger.body.data.map((e: any) => e.type)).toContain('COMMISSION');
  });

  it('partially closes with correct realized P&L', async () => {
    const position = (
      await request(httpServer)
        .get(`/api/accounts/${accountId}/positions`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body[0];

    const close = await request(httpServer)
      .post(`/api/positions/${position.id}/close`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity: 0.1 })
      .expect(201);
    expect(close.body.status).toBe('FILLED');
    expect(close.body.side).toBe('SELL');

    const after = (
      await request(httpServer)
        .get(`/api/accounts/${accountId}/positions`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body;
    expect(after[0].quantity).toBeCloseTo(0.15, 8);

    const closed = await request(httpServer)
      .get(`/api/accounts/${accountId}/closed-positions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(closed.body.length).toBe(1);
    expect(closed.body[0].isPartialClose).toBe(true);
    expect(closed.body[0].quantity).toBe(0.1);
    const expectedPnl = (close.body.avgFillPrice - position.entryPrice) * 0.1;
    expect(closed.body[0].realizedPnl).toBeCloseTo(expectedPnl, 6);

    const stats = await request(httpServer)
      .get(`/api/accounts/${accountId}/stats`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(stats.body.totalTrades).toBe(1);
  });

  it('rejects oversized orders with INSUFFICIENT_MARGIN', async () => {
    const res = await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 5000 })
      .expect(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_MARGIN');
    expect(res.body.error.details.required).toBeGreaterThan(0);
  });

  it('rejects invalid order shapes', async () => {
    await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'BTCUSDT', side: 'HODL', type: 'MARKET', quantity: 1 })
      .expect(400);

    const res = await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1 })
      .expect(422);
    expect(res.body.error.code).toBe('PRICE_REQUIRED');
  });

  it('rests a far limit order, then cancels it', async () => {
    const tick = (await request(httpServer).get('/api/market-data/ticks/ETHUSDT').expect(200))
      .body;
    const farPrice = Math.round(tick.bid * 0.5 * 10) / 10; // tickSize 0.001 for ETH (price>=100 → 0.01)

    const order = await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'ETHUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: farPrice })
      .expect(201);
    expect(order.body.status).toBe('OPEN');

    const cancelled = await request(httpServer)
      .delete(`/api/orders/${order.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    // double cancel → conflict
    await request(httpServer)
      .delete(`/api/orders/${order.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('fills a marketable limit order at the better price', async () => {
    const tick = (await request(httpServer).get('/api/market-data/ticks/SOLUSDT').expect(200))
      .body;
    const aggressive = Math.round(tick.ask * 1.05 * 100) / 100; // SOL tick size is 0.01

    const order = await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'SOLUSDT', side: 'BUY', type: 'LIMIT', quantity: 5, price: aggressive })
      .expect(201);
    expect(order.body.status).toBe('FILLED');
    expect(order.body.avgFillPrice).toBeLessThanOrEqual(tick.ask); // price improvement
  });

  it('scopes accounts to their owner', async () => {
    const other = await request(httpServer)
      .post('/api/auth/demo')
      .expect(201);
    const forbidden = await request(httpServer)
      .get(`/api/accounts/${accountId}`)
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(403);
    expect(forbidden.body.error.code).toBe('ACCOUNT_FORBIDDEN');
  });

  it('serves the equity curve and fills history', async () => {
    const equity = await request(httpServer)
      .get(`/api/accounts/${accountId}/equity-curve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(equity.body.length).toBeGreaterThan(1);

    const fills = await request(httpServer)
      .get(`/api/accounts/${accountId}/fills`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(fills.body.total).toBeGreaterThanOrEqual(3);
  });

  it('streams ticks, candles and account events over the websocket', async () => {
    const ws = new WebSocket(wsUrl.replace('/ws', `/ws?token=${encodeURIComponent(token)}`));
    const received: any[] = [];
    const channels = new Set();

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.channel && msg.event) {
        channels.add(msg.channel.split(':')[0]);
        received.push(msg);
      }
    });

    ws.send(JSON.stringify({ op: 'subscribe', channel: 'ticks' }));
    ws.send(JSON.stringify({ op: 'subscribe', channel: 'candles:BTCUSDT:1m' }));
    ws.send(JSON.stringify({ op: 'subscribe', channel: 'account' }));
    ws.send(JSON.stringify({ op: 'ping' }));

    // trade something while listening
    await request(httpServer)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, symbolName: 'DOGEUSDT', side: 'BUY', type: 'MARKET', quantity: 1000 })
      .expect(201);

    await new Promise((r) => setTimeout(r, 2500));
    ws.close();

    expect(channels.has('ticks')).toBe(true);
    expect(channels.has('candles')).toBe(true);
    expect(channels.has('account')).toBe(true);
    const accountEvents = received.filter((m) => m.channel === 'account').map((m) => m.event.type);
    for (const kind of ['order', 'fill', 'position', 'balance']) {
      expect(accountEvents).toContain(kind);
    }
  });
});
