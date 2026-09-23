import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PersistenceModule } from './persistence/persistence.module';
import { PriceSourceModule } from './price-source/price-source.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AuthModule } from './auth/auth.module';
import { MarketDataModule } from './market-data/market-data.module';
import { TradingModule } from './trading/trading.module';
import { StatusModule } from './status/status.module';

@Module({
  imports: [
    AppConfigModule, // global — provides CONFIG
    PersistenceModule, // global — SQLite (node:sqlite)
    PriceSourceModule, // global — binance/simulator + registry
    RealtimeModule, // global — ws hub at /ws
    AuthModule,
    MarketDataModule,
    TradingModule,
    StatusModule,
  ],
})
export class AppModule {}
