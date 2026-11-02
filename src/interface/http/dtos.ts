import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

/** O DTO só valida FORMA; o contrato monetário (escala, sinal…) é do `Money.from`. `amount` é sempre string. */
export class MoneyDto {
  @ApiProperty({ example: '25.00', pattern: '^\\d+(\\.\\d{1,2})?$', description: 'Valor decimal não negativo, sem notação científica.' })
  @IsString()
  amount!: string;

  @ApiProperty({ example: 'BRL', pattern: '^[A-Z]{3}$' })
  @IsString()
  currency!: string;
}

export class CreateWalletDto {
  @ApiProperty({ example: 'player-123', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  playerId!: string;

  @ApiProperty({ type: MoneyDto })
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitTransactionDto {
  @ApiProperty({ example: 'provider-a', maxLength: 128 }) @IsString() @IsNotEmpty() @MaxLength(128) providerId!: string;
  @ApiProperty({ example: 'transaction-123', maxLength: 128 }) @IsString() @IsNotEmpty() @MaxLength(128) externalTransactionId!: string;
  @ApiProperty({ example: 'player-123', maxLength: 128 }) @IsString() @IsNotEmpty() @MaxLength(128) playerId!: string;
  @ApiProperty({ format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' }) @IsUUID() walletId!: string;
  @ApiProperty({ example: 'round-987', maxLength: 128 }) @IsString() @IsNotEmpty() @MaxLength(128) roundId!: string;
  @ApiProperty({ example: 'fortune-chimp', maxLength: 128 }) @IsString() @IsNotEmpty() @MaxLength(128) gameId!: string;
  @ApiProperty({ enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'], example: 'BET' }) @IsString() @IsNotEmpty() kind!: string;

  @ApiProperty({ type: MoneyDto })
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ApiPropertyOptional({ example: 'transaction-122', maxLength: 128, description: 'Obrigatório para REFUND e ROLLBACK.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
