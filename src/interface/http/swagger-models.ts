import { ApiProperty } from '@nestjs/swagger';

export class MoneyResponseModel {
  @ApiProperty({ example: '975.00', pattern: '^\\d+\\.\\d{2}$' })
  amount!: string;

  @ApiProperty({ example: 'BRL', pattern: '^[A-Z]{3}$' })
  currency!: string;
}

export class WalletResponseModel {
  @ApiProperty({ format: 'uuid', example: '0192f291-27dd-7d3f-8071-5f8685deef37' })
  id!: string;

  @ApiProperty({ example: 'player-123' })
  playerId!: string;

  @ApiProperty({ type: MoneyResponseModel })
  balance!: MoneyResponseModel;

  @ApiProperty({ example: 1, minimum: 1 })
  version!: number;
}

export class LedgerEntryResponseModel {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'], example: 'DEBIT' })
  direction!: string;

  @ApiProperty({ type: MoneyResponseModel })
  money!: MoneyResponseModel;

  @ApiProperty({ type: MoneyResponseModel })
  balanceBefore!: MoneyResponseModel;

  @ApiProperty({ type: MoneyResponseModel })
  balanceAfter!: MoneyResponseModel;

  @ApiProperty({ format: 'date-time', example: '2026-11-02T22:04:58.527Z' })
  createdAt!: string;
}

export class LedgerPageResponseModel {
  @ApiProperty({ type: [LedgerEntryResponseModel] })
  items!: LedgerEntryResponseModel[];

  @ApiProperty({ type: String, nullable: true, example: 'djE6NDI' })
  nextCursor!: string | null;
}

export class TransactionResponseModel {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'provider-a' })
  providerId!: string;

  @ApiProperty({ example: 'transaction-123' })
  externalTransactionId!: string;

  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ example: 'player-123' })
  playerId!: string;

  @ApiProperty({ example: 'round-987' })
  roundId!: string;

  @ApiProperty({ example: 'fortune-chimp' })
  gameId!: string;

  @ApiProperty({ enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'], example: 'BET' })
  kind!: string;

  @ApiProperty({ type: MoneyResponseModel })
  money!: MoneyResponseModel;

  @ApiProperty({ enum: ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'], example: 'PROCESSED' })
  status!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  failureCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  referenceExternalTransactionId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  referenceTransactionId!: string | null;

  @ApiProperty({ type: MoneyResponseModel, nullable: true })
  balance!: MoneyResponseModel | null;

  @ApiProperty({ format: 'date-time', example: '2026-11-02T22:04:58.527Z' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-02T22:04:58.527Z' })
  processedAt!: string | null;
}

export class SubmitTransactionResponseModel {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ enum: ['PENDING', 'PENDING_REFERENCE', 'PROCESSED'], example: 'PROCESSED' })
  status!: string;

  @ApiProperty({ type: MoneyResponseModel, nullable: true })
  balance!: MoneyResponseModel | null;

  @ApiProperty({ example: false })
  idempotentReplay!: boolean;
}

export class ErrorDetailResponseModel {
  @ApiProperty({ example: 'INSUFFICIENT_FUNDS' })
  code!: string;

  @ApiProperty({ example: 'Transaction rejected: INSUFFICIENT_FUNDS' })
  message!: string;

  @ApiProperty({ example: false })
  retryable!: boolean;
}

export class RejectedTransactionResponseModel extends SubmitTransactionResponseModel {
  @ApiProperty({ example: 'INSUFFICIENT_FUNDS' })
  failureCode!: string;

  @ApiProperty({ type: () => ErrorDetailResponseModel })
  error!: ErrorDetailResponseModel;

  @ApiProperty({ example: '0192f298-345e-7e38-af88-e43f851a819d' })
  correlationId!: string;
}

export class ReconciliationResponseModel {
  @ApiProperty({ format: 'uuid' })
  walletId!: string;

  @ApiProperty({ type: MoneyResponseModel })
  storedBalance!: MoneyResponseModel;

  @ApiProperty({ type: MoneyResponseModel })
  calculatedBalance!: MoneyResponseModel;

  @ApiProperty({ type: MoneyResponseModel })
  difference!: MoneyResponseModel;

  @ApiProperty({ example: true })
  consistent!: boolean;

  @ApiProperty({ example: 42, minimum: 0 })
  checkedEntries!: number;
}

export class ErrorResponseModel {
  @ApiProperty({ type: () => ErrorDetailResponseModel })
  error!: ErrorDetailResponseModel;

  @ApiProperty({ example: '0192f298-345e-7e38-af88-e43f851a819d' })
  correlationId!: string;
}

export class HealthLiveResponseModel {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: string;
}

export class HealthReadyResponseModel {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: string;

  @ApiProperty({ enum: ['up'], example: 'up' })
  database!: string;

  @ApiProperty({ enum: ['up'], example: 'up' })
  queue!: string;
}
