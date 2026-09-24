import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { ApiError } from '../common/api-error';
import type { Candle, SymbolInfo, Timeframe } from '../domain/types';
import { BinanceSource } from './binance/binance.source';
import type { PriceSource, StreamRequest } from './price-source';
import { SimulatorSource } from './simulator/simulator.source';

export interface PriceSourceStatus {
  mode: 'live' | 'simulated';
  provider: 'binance' | 'simulator';
  healthy: boolean;
  since: string;
  symbols: number;
  lastTickAt: string | null;
  note?: string;
}

/**
 * Chooses and supervises the active price source.
 *
 *  - mode "live"      → Binance only; startup fails if unreachable.
 *  - mode "simulated" → built-in simulator only.
 *  - mode "auto"      → try Binance first; on failure fall back to the
 *    simulator so the platform always boots. While running on the simulator
 *    we periodically retry Binance and upgrade when it comes back.
 */
@Injectable()
export class PriceSourceRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(PriceSourceRegistry.name);

  private active: PriceSource | null = null;
  private activeSince = 0;
  private statusNote: string | undefined;
  private upgradeTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly binance: BinanceSource,
    private readonly simulator: SimulatorSource,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const mode = this.config.marketData.mode;
    if (mode === 'simulated') {
      await this.activate(this.simulator, 'Simulated market data (configured mode)');
      return;
    }

    if (mode === 'live') {
      try {
        await this.activate(this.binance);
      } catch (error) {
        this.active = null;
        throw new ApiError(
          503,
          'MARKET_DATA_UNAVAILABLE',
          `Live market data required but Binance is unreachable: ${(error as Error).message}`,
        );
      }
      return;
    }

    // auto
    try {
      await this.activate(this.binance);
      return;
    } catch (error) {
      this.logger.warn(
        `Binance unreachable (${(error as Error).message}) — falling back to the built-in simulator`,
      );
      await this.activate(
        this.simulator,
        `Binance unreachable (${(error as Error).message}); running on the built-in simulator`,
      );
      this.scheduleUpgradeAttempt();
    }
  }

  private async activate(source: PriceSource, note?: string): Promise<void> {
    if (this.active && this.active !== source) {
      await this.safeStop(this.active);
    }
    await source.start();
    this.active = source;
    this.activeSince = Date.now();
    this.statusNote = note;
  }

  private scheduleUpgradeAttempt(): void {
    if (this.upgradeTimer) return;
    this.upgradeTimer = setInterval(
      () => {
        void this.tryUpgrade();
      },
      60_000,
    );
  }

  private async tryUpgrade(): Promise<void> {
    if (!this.active || this.active.id !== 'simulator') {
      if (this.upgradeTimer) clearInterval(this.upgradeTimer);
      this.upgradeTimer = null;
      return;
    }
    try {
      // A cheap reachability probe: exchangeInfo.
      await this.binance.listSymbols();
      await this.activate(this.binance, 'Upgraded to live Binance market data');
      this.logger.log('Upgraded from simulator to live Binance market data');
      if (this.upgradeTimer) clearInterval(this.upgradeTimer);
      this.upgradeTimer = null;
    } catch {
      // still offline — keep simulating
    }
  }

  private async safeStop(source: PriceSource): Promise<void> {
    try {
      await source.stop();
    } catch {
      /* noop */
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.upgradeTimer) clearInterval(this.upgradeTimer);
    if (this.active) await this.safeStop(this.active);
  }

  /** The active source; throws if start() has not completed. */
  source(): PriceSource {
    if (!this.active) {
      throw new ApiError(503, 'MARKET_DATA_STARTING', 'Market data source is still starting');
    }
    return this.active;
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return this.source().listSymbols();
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit: number,
    fromMs?: number,
    toMs?: number,
  ): Promise<Candle[]> {
    return this.source().getCandles(symbol, timeframe, limit, fromMs, toMs);
  }

  ensureStreams(requests: StreamRequest[]): void {
    this.source().ensureStreams(requests);
  }

  status(): PriceSourceStatus {
    if (!this.active) {
      return {
        mode: 'simulated',
        provider: 'simulator',
        healthy: false,
        since: new Date().toISOString(),
        symbols: 0,
        lastTickAt: null,
        note: 'starting',
      };
    }
    const lastTickAt = this.active.lastEventAt();
    return {
      mode: this.active.id === 'binance' ? 'live' : 'simulated',
      provider: this.active.id,
      healthy: this.active.isHealthy(),
      since: new Date(this.activeSince).toISOString(),
      symbols: 0, // filled by MarketDataService which owns the symbol registry
      lastTickAt: lastTickAt > 0 ? new Date(lastTickAt).toISOString() : null,
      note: this.statusNote,
    };
  }
}
