import { Body, Controller, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';
import { MatchingEngineService } from './matching-engine.service';
import { AmendProtectionDto, ClosePositionDto, EntityIdDto } from './dto/trading.dto';

@ApiTags('positions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('positions')
export class PositionsController {
  constructor(private readonly engine: MatchingEngineService) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Amend take-profit / stop-loss on an open position' })
  amend(
    @CurrentUser() user: JwtPayload,
    @Param() params: EntityIdDto,
    @Body() dto: AmendProtectionDto,
  ) {
    return this.engine.amendPositionProtection(user.sub, params.id, dto);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close a position (fully or partially) at market' })
  close(
    @CurrentUser() user: JwtPayload,
    @Param() params: EntityIdDto,
    @Body() dto: ClosePositionDto,
  ) {
    return this.engine.closePosition(user.sub, params.id, dto);
  }
}
