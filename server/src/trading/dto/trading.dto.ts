import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PlaceOrderDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  accountId!: string;

  @IsString()
  @Matches(/^[A-Z0-9]{4,20}$/)
  symbolName!: string;

  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT', 'STOP'])
  type!: 'MARKET' | 'LIMIT' | 'STOP';

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(1_000_000)
  quantity!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  stopPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  takeProfit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  stopLoss?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  comment?: string;
}

export class AmendProtectionDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  takeProfit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  stopLoss?: number;
}

export class ClosePositionDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  quantity?: number;
}

export class CreateAccountDto {
  @IsString()
  @IsIn(['demo-standard', 'demo-mini', 'evaluation-pro'])
  templateId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class EquityCurveDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  toMs?: number;
}

export class OrderFilterDto extends PaginationDto {
  @IsOptional()
  @IsIn(['OPEN', 'FILLED', 'CANCELLED', 'REJECTED'])
  status?: 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
}

export class AccountIdDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  id!: string;
}

export class EntityIdDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  id!: string;
}
