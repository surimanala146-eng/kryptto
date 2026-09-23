import { Global, Module } from '@nestjs/common';
import { BinanceSource } from './binance/binance.source';
import { PriceSourceRegistry } from './price-source.registry';
import { SimulatorSource } from './simulator/simulator.source';

@Global()
@Module({
  providers: [BinanceSource, SimulatorSource, PriceSourceRegistry],
  exports: [PriceSourceRegistry],
})
export class PriceSourceModule {}
