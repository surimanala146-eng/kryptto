import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { nowIso, ulid } from '../common/ids';
import type {
  Account,
  ClosedPosition,
  Fill,
  Order,
  Position,
  SymbolInfo,
  Tick,
} from '../domain/types';
import { DatabaseService } from '../persistence/database.service';
import { MarketDataService } from '../market-data/market-data.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AccountMetricsService } from './account-metrics.service';
import { TradingStore } from './trading.store';
import type { AmendProtectionDto, ClosePositionDto, PlaceOrderDto } from './dto/trading.dto';

const EQUITY_SNAPSHOT_INTERVAL_MS = 60_000;

/**
 * The paper-trading core.
 *
 * Responsibilities:
 *  - validate + place orders (MARKET fills instantly; LIMIT/STOP rest)
 *  - evaluate resting orders against the live tick stream and fill them
 *  - evaluate take-profit / stop-loss on open positions
 *  - net positions (open / increase / reduce / flip), realize P&L, charge
 *    commission, record ledger entries and equity snapshots — atomically
 *  - push `account` channel events to the position owner over WebSocket
 */
@Injectable()
export class MatchingEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchingEngineService.name);
  private readonly restingBySymbol = new Map<string, Order[]>();
  private snapshotTimer: NodeJS.Timeout | null = null;
  private unsubscribeTicks: (() => void) | null = null;

  constructor(
    private readonly store: TradingStore,
    private readonly db: DatabaseService,
    private readonly marketData: MarketDataService,
    private readonly realtime: RealtimeService,
    private readonly metrics: AccountMetricsService,
  ) {}

  onModuleInit(): void {
    for (const order of this.store.listOpenOrders()) {
      this.indexResting(order);
    }
    this.unsubscribeTicks = this.marketData.onTick((tick) => this.handleTick(tick));
    this.snapshotTimer = setInterval(() => this.snapshotSweep(), EQUITY_SNAPSHOT_INTERVAL_MS);
    this.logger.log(
      `Matching engine armed — ${this.restingCount()} resting order(s) restored`,
    );
  }

  onModuleDestroy(): void {
    this.unsubscribeTicks?.();
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
  }

  // ── public trading operations ───────────────────────────────────────────

  placeOrder(userId: string, dto: PlaceOrderDto): Order {
    const account = this.requireAccount(userId, dto.accountId);
    const symbol = this.marketData.getSymbol(dto.symbolName);
    const tick = this.requireTick(dto.symbolName);
    this.validateOrderShape(dto, symbol, tick);

    // Margin / risk check.
    const quantity = round(dto.quantity, 8);
    const refPrice = dto.type === 'LIMIT' ? (dto.price as number) : dto.side === 'BUY' ? tick.ask : tick.bid;
    this.assertMarginAvailable(account, symbol, dto.side, quantity, refPrice);

    const now = nowIso();
    const order: Order = {
      id: ulid(),
      accountId: account.id,
      symbolName: symbol.name,
      side: dto.side,
      type: dto.type,
      quantity,
      price: dto.type === 'LIMIT' ? dto.price ?? null : null,
      stopPrice: dto.type === 'STOP' ? dto.stopPrice ?? null : null,
      takeProfit: dto.takeProfit ?? null,
      stopLoss: dto.stopLoss ?? null,
      status: 'OPEN',
      filledQuantity: 0,
      avgFillPrice: null,
      comment: dto.comment ?? null,
      createdAt: now,
      updatedAt: now,
    };

    // Immediately marketable?
    const marketable = this.marketablePrice(order, tick);
    this.store.insertOrder(order);
    if (marketable !== null) {
      this.executeFill(order, marketable.price, marketable.execution);
      return this.store.getOrder(order.id) as Order;
    }

    this.indexResting(order);
    this.publishAccountEvent(account.id, { type: 'order', order });
    return order;
  }

  cancelOrder(userId: string, orderId: string): Order {
    const order = this.store.getOrder(orderId);
    if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
    const account = this.requireAccount(userId, order.accountId);
    if (order.status !== 'OPEN') {
      throw ApiError.conflict(`Order is ${order.status}, only OPEN orders can be cancelled`, 'ORDER_NOT_CANCELLABLE');
    }
    this.store.updateOrderStatus(order.id, 'CANCELLED', order.filledQuantity, order.avgFillPrice, nowIso());
    this.unindexResting(order);
    const updated = this.store.getOrder(order.id) as Order;
    this.publishAccountEvent(account.id, { type: 'order', order: updated });
    return updated;
  }

  amendOrderProtection(userId: string, orderId: string, dto: AmendProtectionDto): Order {
    const order = this.store.getOrder(orderId);
    if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
    this.requireAccount(userId, order.accountId);
    if (order.status !== 'OPEN') {
      throw ApiError.conflict('Only OPEN orders can be amended', 'ORDER_NOT_AMENDABLE');
    }
    const takeProfit = dto.takeProfit ?? order.takeProfit;
    const stopLoss = dto.stopLoss ?? order.stopLoss;
    this.store.updateOrderProtection(order.id, takeProfit, stopLoss, nowIso());
    const updated = this.store.getOrder(order.id) as Order;
    this.syncResting(updated);
    this.publishAccountEvent(order.accountId, { type: 'order', order: updated });
    return updated;
  }

  amendPositionProtection(userId: string, positionId: string, dto: AmendProtectionDto): Position {
    const position = this.store.getPosition(positionId);
    if (!position) throw ApiError.notFound('Position not found', 'POSITION_NOT_FOUND');
    const account = this.requireAccount(userId, position.accountId);

    const takeProfit = dto.takeProfit ?? position.takeProfit;
    const stopLoss = dto.stopLoss ?? position.stopLoss;
    if (takeProfit != null && stopLoss != null && takeProfit <= stopLoss) {
      throw ApiError.unprocessable('takeProfit must be above stopLoss', 'INVALID_PROTECTION');
    }
    if (takeProfit != null) {
      if (position.side === 'LONG' && takeProfit <= position.entryPrice) {
        throw ApiError.unprocessable(
          'For LONG positions takeProfit must be above the entry price',
          'INVALID_PROTECTION',
        );
      }
      if (position.side === 'SHORT' && takeProfit >= position.entryPrice) {
        throw ApiError.unprocessable(
          'For SHORT positions takeProfit must be below the entry price',
          'INVALID_PROTECTION',
        );
      }
    }
    if (stopLoss != null) {
      if (position.side === 'LONG' && stopLoss >= position.entryPrice) {
        throw ApiError.unprocessable(
          'For LONG positions stopLoss must be below the entry price',
          'INVALID_PROTECTION',
        );
      }
      if (position.side === 'SHORT' && stopLoss <= position.entryPrice) {
        throw ApiError.unprocessable(
          'For SHORT positions stopLoss must be above the entry price',
          'INVALID_PROTECTION',
        );
      }
    }
    this.store.updatePositionProtection(position.id, takeProfit, stopLoss);
    const updated = this.metrics.decoratePosition(
      this.store.getPosition(position.id) as Position,
      account.leverage,
    );
    this.publishAccountEvent(position.accountId, { type: 'position', position: updated });
    return updated;
  }

  closePosition(userId: string, positionId: string, dto: ClosePositionDto): Order {
    const position = this.store.getPosition(positionId);
    if (!position) throw ApiError.notFound('Position not found', 'POSITION_NOT_FOUND');
    const account = this.requireAccount(userId, position.accountId);
    const tick = this.requireTick(position.symbolName);
    const quantity = round(Math.min(dto.quantity ?? position.quantity, position.quantity), 8);
    if (quantity <= 0) throw ApiError.unprocessable('Quantity must be positive', 'INVALID_QUANTITY');

    const now = nowIso();
    const order: Order = {
      id: ulid(),
      accountId: account.id,
      symbolName: position.symbolName,
      side: position.side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity,
      price: null,
      stopPrice: null,
      takeProfit: null,
      stopLoss: null,
      status: 'OPEN',
      filledQuantity: 0,
      avgFillPrice: null,
      comment: 'manual close',
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertOrder(order);
    const price = order.side === 'BUY' ? tick.ask : tick.bid;
    this.executeFill(order, price, 'market');
    return this.store.getOrder(order.id) as Order;
  }

  /** Live view of an account's positions (decorated with mark/P&L). */
  listPositions(userId: string, accountId: string): Position[] {
    const account = this.requireAccount(userId, accountId);
    return this.metrics.decoratePositions(account.id, account.leverage);
  }

  listOpenOrders(userId: string, accountId: string): Order[] {
    this.requireAccount(userId, accountId);
    return this.store.listOpenOrdersForAccount(accountId);
  }

  // ── tick evaluation ─────────────────────────────────────────────────────

  private handleTick(tick: Tick): void {
    try {
      this.evaluateRestingOrders(tick);
      this.evaluatePositionProtection(tick);
    } catch (error) {
      this.logger.error(`Tick evaluation failed for ${tick.symbol}: ${(error as Error).message}`);
    }
  }

  private evaluateRestingOrders(tick: Tick): void {
    const orders = this.restingBySymbol.get(tick.symbol);
    if (!orders || orders.length === 0) return;
    for (const order of [...orders]) {
      const marketable = this.marketablePrice(order, tick);
      if (marketable !== null) {
        this.executeFill(order, marketable.price, marketable.execution);
      }
    }
  }

  private evaluatePositionProtection(tick: Tick): void {
    const positions = this.store.listPositionsForSymbol(tick.symbol);
    for (const position of positions) {
      let trigger: { price: number; kind: 'take-profit' | 'stop-loss' } | null = null;
      if (position.side === 'LONG') {
        if (position.takeProfit !== null && tick.bid >= position.takeProfit) {
          trigger = { price: position.takeProfit, kind: 'take-profit' };
        } else if (position.stopLoss !== null && tick.bid <= position.stopLoss) {
          trigger = { price: position.stopLoss, kind: 'stop-loss' };
        }
      } else {
        if (position.takeProfit !== null && tick.ask <= position.takeProfit) {
          trigger = { price: position.takeProfit, kind: 'take-profit' };
        } else if (position.stopLoss !== null && tick.ask >= position.stopLoss) {
          trigger = { price: position.stopLoss, kind: 'stop-loss' };
        }
      }
      if (trigger) {
        this.executeProtection(position, trigger.price, trigger.kind);
      }
    }
  }

  /** TP/SL executions create an internal order so fills always reference one. */
  private executeProtection(
    position: Position,
    price: number,
    kind: 'take-profit' | 'stop-loss',
  ): void {
    const now = nowIso();
    const order: Order = {
      id: ulid(),
      accountId: position.accountId,
      symbolName: position.symbolName,
      side: position.side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: position.quantity,
      price: null,
      stopPrice: null,
      takeProfit: null,
      stopLoss: null,
      status: 'OPEN',
      filledQuantity: 0,
      avgFillPrice: null,
      comment: kind,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertOrder(order);
    this.executeFill(order, price, kind);
  }

  /**
   * Decides whether an order is fillable at the given tick and at which price.
   * Returns null when the order should keep resting.
   */
  private marketablePrice(
    order: Order,
    tick: Tick,
  ): { price: number; execution: 'market' | 'limit' | 'stop' } | null {
    switch (order.type) {
      case 'MARKET':
        return { price: order.side === 'BUY' ? tick.ask : tick.bid, execution: 'market' };
      case 'LIMIT':
        if (order.side === 'BUY' && tick.ask <= (order.price as number)) {
          return { price: Math.min(tick.ask, order.price as number), execution: 'limit' };
        }
        if (order.side === 'SELL' && tick.bid >= (order.price as number)) {
          return { price: Math.max(tick.bid, order.price as number), execution: 'limit' };
        }
        return null;
      case 'STOP':
        if (order.side === 'BUY' && tick.ask >= (order.stopPrice as number)) {
          return { price: tick.ask, execution: 'stop' };
        }
        if (order.side === 'SELL' && tick.bid <= (order.stopPrice as number)) {
          return { price: tick.bid, execution: 'stop' };
        }
        return null;
      default:
        return null;
    }
  }

  // ── the transactional fill ──────────────────────────────────────────────

  private executeFill(
    order: Order,
    price: number,
    execution: 'market' | 'limit' | 'stop' | 'take-profit' | 'stop-loss',
  ): Fill {
    const symbol = this.marketData.getSymbol(order.symbolName);
    const accountRow = this.store.getAccountRow(order.accountId);
    if (!accountRow) {
      throw ApiError.notFound('Account vanished mid-execution', 'ACCOUNT_NOT_FOUND');
    }

    const quantity = order.quantity;
    const commission = round(quantity * price * symbol.commission, 10);
    const fillId = ulid();
    const now = nowIso();

    let realizedPnl: number | null = null;
    let positionAfter: Position | null = null;
    let closedRecord: ClosedPosition | null = null;

    this.db.transaction(() => {
      const existing = this.store.getPositionByAccountSymbol(order.accountId, order.symbolName);
      const sameDirection =
        !existing ||
        (existing.side === 'LONG' && order.side === 'BUY') ||
        (existing.side === 'SHORT' && order.side === 'SELL');

      if (sameDirection) {
        // open or increase
        const newQuantity = round((existing?.quantity ?? 0) + quantity, 8);
        const newEntry = existing
          ? round(
              (existing.entryPrice * existing.quantity + price * quantity) / newQuantity,
              symbol.digits + 2,
            )
          : price;
        const position: Position = {
          id: existing?.id ?? ulid(),
          accountId: order.accountId,
          symbolName: order.symbolName,
          side: order.side === 'BUY' ? 'LONG' : 'SHORT',
          quantity: newQuantity,
          entryPrice: newEntry,
          currentPrice: price,
          unrealizedPnl: 0,
          margin: 0,
          contractSize: 1,
          openedAt: existing?.openedAt ?? now,
          takeProfit: existing?.takeProfit ?? order.takeProfit ?? null,
          stopLoss: existing?.stopLoss ?? order.stopLoss ?? null,
        };
        this.store.upsertPosition(position);
        positionAfter = position;
      } else {
        // reduce / close / flip
        const direction = existing.side === 'LONG' ? 1 : -1;
        const closeQuantity = Math.min(existing.quantity, quantity);
        realizedPnl = round(
          (price - existing.entryPrice) * closeQuantity * direction,
          10,
        );
        const remainder = round(quantity - closeQuantity, 8);

        closedRecord = {
          id: ulid(),
          accountId: order.accountId,
          symbolName: order.symbolName,
          side: existing.side,
          quantity: closeQuantity,
          entryPrice: existing.entryPrice,
          exitPrice: price,
          realizedPnl,
          commission,
          swap: 0,
          openedAt: existing.openedAt,
          closedAt: now,
          isPartialClose: closeQuantity < existing.quantity,
        };
        this.store.insertClosedPosition(closedRecord);

        if (closeQuantity < existing.quantity) {
          positionAfter = {
            ...existing,
            quantity: round(existing.quantity - closeQuantity, 8),
          };
          this.store.upsertPosition(positionAfter);
        } else {
          this.store.deletePosition(existing.id);
          positionAfter = null;
          if (remainder > 0) {
            // flip: the excess opens a position on the other side
            positionAfter = {
              id: ulid(),
              accountId: order.accountId,
              symbolName: order.symbolName,
              side: order.side === 'BUY' ? 'LONG' : 'SHORT',
              quantity: remainder,
              entryPrice: price,
              currentPrice: price,
              unrealizedPnl: 0,
              margin: 0,
              contractSize: 1,
              openedAt: now,
              takeProfit: null,
              stopLoss: null,
            };
            this.store.upsertPosition(positionAfter);
          }
        }
      }

      // balances + ledger
      const balanceAfterRealized = accountRow.balance + (realizedPnl ?? 0);
      const newBalance = round(balanceAfterRealized - commission, 10);
      this.store.updateBalance(order.accountId, newBalance, now);

      if (realizedPnl !== null && realizedPnl !== 0) {
        this.store.addLedgerEntry({
          id: ulid(),
          accountId: order.accountId,
          type: 'REALIZED_PNL',
          amount: realizedPnl,
          balance: round(balanceAfterRealized, 10),
          description: `${execution} ${order.side} ${order.symbolName} @ ${price}`,
          referenceId: fillId,
          createdAt: now,
        });
      }
      if (commission > 0) {
        this.store.addLedgerEntry({
          id: ulid(),
          accountId: order.accountId,
          type: 'COMMISSION',
          amount: -commission,
          balance: newBalance,
          description: `commission ${order.symbolName} ${execution}`,
          referenceId: fillId,
          createdAt: now,
        });
      }

      // order + fill rows
      this.store.updateOrderStatus(order.id, 'FILLED', quantity, price, now);
      const fill: Fill = {
        id: fillId,
        orderId: order.id,
        accountId: order.accountId,
        symbolName: order.symbolName,
        side: order.side,
        quantity,
        price,
        commission,
        realizedPnl,
        createdAt: now,
      };
      this.store.insertFill(fill);

      // equity snapshot
      const view = this.metrics.decorateAccount(order.accountId);
      this.store.insertEquityPoint(
        order.accountId,
        view?.equity ?? newBalance,
        newBalance,
        now,
      );
    });

    this.unindexResting(order);

    // events
    const updatedOrder = this.store.getOrder(order.id) as Order;
    this.publishAccountEvent(order.accountId, { type: 'order', order: updatedOrder });
    this.publishAccountEvent(order.accountId, {
      type: 'fill',
      fill: this.store.listFillsForAccount(order.accountId, 1, 1).fills[0] ?? null,
    });
    if (positionAfter) {
      const leverage = accountRow.leverage;
      this.publishAccountEvent(order.accountId, {
        type: 'position',
        position: this.metrics.decoratePosition(positionAfter, leverage),
      });
    }
    if (closedRecord) {
      this.publishAccountEvent(order.accountId, { type: 'position_closed', closed: closedRecord });
    }
    this.publishAccountEvent(order.accountId, {
      type: 'balance',
      account: this.metrics.decorateAccount(order.accountId),
    });

    return {
      id: fillId,
      orderId: order.id,
      accountId: order.accountId,
      symbolName: order.symbolName,
      side: order.side,
      quantity,
      price,
      commission,
      realizedPnl,
      createdAt: now,
    };
  }

  // ── validation helpers ──────────────────────────────────────────────────

  private requireAccount(userId: string, accountId: string): Account {
    const row = this.store.getAccountRow(accountId);
    if (!row) throw ApiError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');
    const account = this.store.mapAccount(row);
    if (account.userId !== userId) {
      throw ApiError.forbidden('This account belongs to another user', 'ACCOUNT_FORBIDDEN');
    }
    if (account.status !== 'ACTIVE') {
      throw ApiError.conflict('Account is not active', 'ACCOUNT_INACTIVE');
    }
    return account;
  }

  private requireTick(symbolName: string): Tick {
    const tick = this.marketData.peekTick(symbolName);
    if (!tick) {
      throw new ApiError(
        503,
        'TICK_NOT_READY',
        `No live price yet for ${symbolName} — try again in a moment`,
      );
    }
    return tick;
  }

  private validateOrderShape(dto: PlaceOrderDto, symbol: SymbolInfo, tick: Tick): void {
    if (dto.quantity < symbol.minQuantity) {
      throw ApiError.unprocessable(
        `Quantity below minimum (${symbol.minQuantity}) for ${symbol.name}`,
        'QUANTITY_TOO_SMALL',
        { minQuantity: symbol.minQuantity },
      );
    }
    if (dto.type === 'LIMIT') {
      if (!dto.price) {
        throw ApiError.unprocessable('LIMIT orders require a price', 'PRICE_REQUIRED');
      }
      this.assertPriceAligned(dto.price, symbol);
    }
    if (dto.type === 'STOP' && !dto.stopPrice) {
      throw ApiError.unprocessable('STOP orders require a stopPrice', 'STOP_PRICE_REQUIRED');
    }
    if (dto.type === 'STOP' && dto.stopPrice) {
      this.assertPriceAligned(dto.stopPrice, symbol);
    }
    if (dto.type === 'MARKET' && (dto.price || dto.stopPrice)) {
      throw ApiError.unprocessable('MARKET orders cannot carry price/stopPrice', 'INVALID_ORDER');
    }
    if (dto.takeProfit !== undefined && dto.stopLoss !== undefined && dto.takeProfit <= dto.stopLoss) {
      throw ApiError.unprocessable('takeProfit must be above stopLoss', 'INVALID_PROTECTION');
    }
    void tick;
  }

  private assertPriceAligned(price: number, symbol: SymbolInfo): void {
    const epsilon = symbol.tickSize / 1000;
    if (Math.abs(price / symbol.tickSize - Math.round(price / symbol.tickSize)) * symbol.tickSize > epsilon) {
      throw ApiError.unprocessable(
        `Price must be aligned to the ${symbol.name} tick size (${symbol.tickSize})`,
        'PRICE_NOT_ALIGNED',
        { tickSize: symbol.tickSize },
      );
    }
  }

  private assertMarginAvailable(
    account: Account,
    symbol: SymbolInfo,
    side: 'BUY' | 'SELL',
    quantity: number,
    refPrice: number,
  ): void {
    const existing = this.store.getPositionByAccountSymbol(account.id, symbol.name);
    const reducing =
      existing &&
      ((existing.side === 'LONG' && side === 'SELL') ||
        (existing.side === 'SHORT' && side === 'BUY'));

    let openingQuantity = quantity;
    if (reducing && existing) {
      const closeQuantity = Math.min(existing.quantity, quantity);
      openingQuantity = round(quantity - closeQuantity, 8);
    }
    if (openingQuantity <= 0) return; // pure reduction — no margin needed

    const required = (openingQuantity * refPrice) / account.leverage;
    const view = this.metrics.decorateAccount(account.id);
    const available = view?.freeMargin ?? 0;
    if (required > available) {
      throw ApiError.unprocessable(
        'Insufficient free margin for this order',
        'INSUFFICIENT_MARGIN',
        {
          required: round(required, 2),
          available: round(available, 2),
          leverage: account.leverage,
        },
      );
    }
  }

  // ── resting order index ─────────────────────────────────────────────────

  private indexResting(order: Order): void {
    if (order.status !== 'OPEN' || order.type === 'MARKET') return;
    const list = this.restingBySymbol.get(order.symbolName) ?? [];
    list.push(order);
    this.restingBySymbol.set(order.symbolName, list);
  }

  private unindexResting(order: Order): void {
    const list = this.restingBySymbol.get(order.symbolName);
    if (!list) return;
    const index = list.findIndex((candidate) => candidate.id === order.id);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.restingBySymbol.delete(order.symbolName);
  }

  private syncResting(order: Order): void {
    const list = this.restingBySymbol.get(order.symbolName);
    if (!list) return;
    const index = list.findIndex((candidate) => candidate.id === order.id);
    if (index >= 0) list[index] = order;
  }

  private restingCount(): number {
    return [...this.restingBySymbol.values()].reduce((sum, list) => sum + list.length, 0);
  }

  // ── events / snapshots ──────────────────────────────────────────────────

  private publishAccountEvent(accountId: string, event: unknown): void {
    const userId = this.store.getAccountOwner(accountId);
    if (userId) {
      this.realtime.publishToUser(userId, 'account', event);
    }
  }

  private snapshotSweep(): void {
    try {
      for (const accountId of this.store.listAccountIdsWithPositions()) {
        const view = this.metrics.decorateAccount(accountId);
        if (view) {
          this.store.insertEquityPoint(accountId, view.equity, view.balance, nowIso());
        }
      }
    } catch (error) {
      this.logger.warn(`Equity snapshot sweep failed: ${(error as Error).message}`);
    }
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
