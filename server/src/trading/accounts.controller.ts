import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../common/guards/jwt-auth.guard';
import { AccountsService } from './accounts.service';
import { StatsService } from './stats.service';
import { MatchingEngineService } from './matching-engine.service';
import { ACCOUNT_TEMPLATES } from './trading.store';
import {
  AccountIdDto,
  CreateAccountDto,
  EquityCurveDto,
  OrderFilterDto,
  PaginationDto,
} from './dto/trading.dto';

@ApiTags('accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly statsService: StatsService,
    private readonly engine: MatchingEngineService,
  ) {}

  @Get('me/list')
  @ApiOperation({ summary: 'All paper accounts of the current user' })
  list(@CurrentUser() user: JwtPayload) {
    return this.accounts.listAccounts(user.sub);
  }

  @Get('templates')
  @ApiOperation({ summary: 'Available account templates' })
  templates() {
    return Object.values(ACCOUNT_TEMPLATES);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new paper account from a template' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAccountDto) {
    return this.accounts.createAccount(user.sub, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One account with live equity/margin' })
  get(@CurrentUser() user: JwtPayload, @Param() params: AccountIdDto) {
    return this.accounts.getAccount(user.sub, params.id);
  }

  @Get(':id/ledger')
  @ApiOperation({ summary: 'Cash ledger (deposits, commissions, realized P&L)' })
  ledger(
    @CurrentUser() user: JwtPayload,
    @Param() params: AccountIdDto,
    @Query() pagination: PaginationDto,
  ) {
    return this.accounts.ledger(user.sub, params.id, pagination);
  }

  @Get(':id/fills')
  @ApiOperation({ summary: 'Execution history' })
  fills(
    @CurrentUser() user: JwtPayload,
    @Param() params: AccountIdDto,
    @Query() pagination: PaginationDto,
  ) {
    return this.accounts.fills(user.sub, params.id, pagination);
  }

  @Get(':id/orders')
  @ApiOperation({ summary: 'Order history (optionally filtered by status)' })
  orders(
    @CurrentUser() user: JwtPayload,
    @Param() params: AccountIdDto,
    @Query() filter: OrderFilterDto,
  ) {
    return this.accounts.orders(user.sub, params.id, filter);
  }

  @Get(':id/positions')
  @ApiOperation({ summary: 'Open positions with live marks' })
  positions(@CurrentUser() user: JwtPayload, @Param() params: AccountIdDto) {
    return this.engine.listPositions(user.sub, params.id);
  }

  @Get(':id/closed-positions')
  @ApiOperation({ summary: 'Closed position records' })
  closedPositions(@CurrentUser() user: JwtPayload, @Param() params: AccountIdDto) {
    return this.accounts.closedPositions(user.sub, params.id);
  }

  @Get(':id/equity-curve')
  @ApiOperation({ summary: 'Equity/balance history for charting' })
  equityCurve(
    @CurrentUser() user: JwtPayload,
    @Param() params: AccountIdDto,
    @Query() query: EquityCurveDto,
  ) {
    return this.accounts.equityCurve(user.sub, params.id, query);
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Performance statistics (win rate, PF, drawdown…)' })
  stats(@CurrentUser() user: JwtPayload, @Param() params: AccountIdDto) {
    return this.statsService.compute(user.sub, params.id);
  }
}
