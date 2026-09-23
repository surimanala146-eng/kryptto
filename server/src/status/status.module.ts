import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { StatusController } from './status.controller';

@Module({
  imports: [MarketDataModule],
  controllers: [StatusController],
})
export class StatusModule {}
