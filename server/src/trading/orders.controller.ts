import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';
import { MatchingEngineService } from './matching-engine.service';
import { AmendProtectionDto, EntityIdDto, PlaceOrderDto } from './dto/trading.dto';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly engine: MatchingEngineService) {}

  @Post()
  @ApiOperation({
    summary: 'Place an order (MARKET fills instantly; LIMIT/STOP rest until triggered)',
  })
  place(@CurrentUser() user: JwtPayload, @Body() dto: PlaceOrderDto) {
    return this.engine.placeOrder(user.sub, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a resting order' })
  cancel(@CurrentUser() user: JwtPayload, @Param() params: EntityIdDto) {
    return this.engine.cancelOrder(user.sub, params.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Amend take-profit / stop-loss on a resting order' })
  amend(
    @CurrentUser() user: JwtPayload,
    @Param() params: EntityIdDto,
    @Body() dto: AmendProtectionDto,
  ) {
    return this.engine.amendOrderProtection(user.sub, params.id, dto);
  }
}
