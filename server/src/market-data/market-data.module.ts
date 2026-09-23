import { Module } from '@nestjs/common';
import { CandlesService } from './candles.service';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';

@Module({
  controllers: [MarketDataController],
  providers: [CandlesService, MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
