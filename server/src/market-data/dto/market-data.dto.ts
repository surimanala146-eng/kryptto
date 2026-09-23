import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { TIMEFRAMES } from '../../domain/types';

export class CandlesQueryDto {
  @IsString()
  @Matches(/^[A-Z0-9]{4,20}$/)
  symbol!: string;

  @IsString()
  @Matches(new RegExp(`^(${TIMEFRAMES.join('|')})$`))
  timeframe!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1500)
  limit?: number;

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

export class SymbolParamDto {
  @IsString()
  @MinLength(4)
  @Matches(/^[A-Z0-9]{4,20}$/)
  symbol!: string;
}
