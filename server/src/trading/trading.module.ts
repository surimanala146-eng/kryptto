import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CONFIG } from '../config/configuration';
import { configProvider } from '../config/config.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountMetricsService } from './account-metrics.service';
import { MatchingEngineService } from './matching-engine.service';
import { OrdersController } from './orders.controller';
import { PositionsController } from './positions.controller';
import { StatsService } from './stats.service';
import { TradingStore } from './trading.store';

@Module({
  imports: [
    MarketDataModule,
    JwtModule.registerAsync({
      useFactory: (config: unknown) => ({
        secret: (config as { jwt: { accessSecret: string } }).jwt.accessSecret,
      }),
      inject: [CONFIG],
    }),
  ],
  controllers: [AccountsController, OrdersController, PositionsController],
  providers: [
    configProvider,
    TradingStore,
    AccountMetricsService,
    MatchingEngineService,
    AccountsService,
    StatsService,
  ],
  exports: [MatchingEngineService, TradingStore, AccountsService],
})
export class TradingModule {}
