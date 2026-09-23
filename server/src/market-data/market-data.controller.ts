import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Candle, OrderBookSnapshot, Tick, TickerStats, Timeframe, TradeEvent } from '../domain/types';
import { MarketDataService } from './market-data.service';
import { CandlesQueryDto, SymbolParamDto } from './dto/market-data.dto';

@ApiTags('market-data')
@Controller('market-data')
export class MarketDataController {
  constructor(private readonly marketData: MarketDataService) {}

  @Get('symbols')
  @ApiOperation({ summary: 'Tradable symbol registry with contract metadata' })
  @ApiOkResponse({ description: 'Symbol list' })
  listSymbols() {
    return this.marketData.listSymbols().map((symbol) => ({ ...symbol, id: symbol.name }));
  }

  @Get('ticks')
  @ApiOperation({ summary: 'Latest bid/ask tick for every streaming symbol' })
  getTicks(): Record<string, Tick> {
    return this.marketData.getTicks();
  }

  @Get('ticks/:symbol')
  @ApiOperation({ summary: 'Latest bid/ask tick for one symbol' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  getTick(@Param() params: SymbolParamDto): Tick {
    return this.marketData.getTick(params.symbol);
  }

  @Get('stats/:symbol')
  @ApiOperation({ summary: 'Rolling 24h statistics for one symbol' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  getStats(@Param() params: SymbolParamDto): TickerStats {
    return this.marketData.getStats(params.symbol);
  }

  @Get('candles')
  @ApiOperation({ summary: 'OHLCV candle history for a symbol + timeframe' })
  @ApiQuery({ name: 'symbol', example: 'BTCUSDT' })
  @ApiQuery({ name: 'timeframe', example: '1m', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] })
  @ApiQuery({ name: 'limit', required: false, example: 500 })
  @ApiQuery({ name: 'fromMs', required: false, example: 1710000000000 })
  @ApiQuery({ name: 'toMs', required: false })
  async getCandles(@Query() query: CandlesQueryDto) {
    const candles = await this.marketData.getCandles(
      query.symbol,
      query.timeframe as Timeframe,
      query.limit ?? 500,
      query.fromMs,
      query.toMs,
    );
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const oldest = sorted.length > 0 ? sorted[0].time : null;
    return {
      candles: sorted.map((candle) => ({
        time: candle.time,
        timestamp: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        closed: candle.closed,
      })),
      metadata: {
        historicalCoverageStart: oldest,
        isPartial: sorted.length > 0 ? !sorted[sorted.length - 1].closed : false,
        backfillQueued: false,
      },
    };
  }

  @Get('orderbook/:symbol')
  @ApiOperation({ summary: 'Latest L2 order book snapshot (needs active stream interest)' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  getOrderBook(@Param() params: SymbolParamDto): OrderBookSnapshot {
    return this.marketData.getOrderBook(params.symbol);
  }

  @Get('trades/:symbol')
  @ApiOperation({ summary: 'Most recent public trades for a symbol' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  getRecentTrades(@Param() params: SymbolParamDto): TradeEvent[] {
    return this.marketData.getRecentTrades(params.symbol);
  }
}
