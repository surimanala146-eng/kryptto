import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CONFIG } from '../config/configuration';
import { MarketDataService } from '../market-data/market-data.service';
import { RealtimeService } from '../realtime/realtime.service';

@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Service health, market data source mode, connection counts' })
  status() {
    return {
      service: 'kryptto-api',
      version: '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      marketData: this.marketData.status(),
      realtime: {
        clients: this.realtime.clientCount(),
        endpoint: '/ws',
      },
      time: new Date().toISOString(),
    };
  }
}
