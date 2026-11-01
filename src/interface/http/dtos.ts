import { Type } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

/** O DTO só valida FORMA; o contrato monetário (escala, sinal…) é do `Money.from`. `amount` é sempre string. */
export class MoneyDto {
  @IsString()
  amount!: string;

  @IsString()
  currency!: string;
}

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitTransactionDto {
  @IsString() @IsNotEmpty() @MaxLength(128) providerId!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) externalTransactionId!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) playerId!: string;
  @IsUUID() walletId!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) roundId!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) gameId!: string;
  @IsString() @IsNotEmpty() kind!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
