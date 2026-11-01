import { BusinessRuleViolation } from './errors';
import { FailureCode } from './failure-codes';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

export type ReferenceResolution = 'APPLICABLE' | 'WAIT';

/**
 * Valida a transação contra a referência já resolvida por (providerId, referenceExternalTransactionId).
 * - Lança BusinessRuleViolation quando a referência torna a operação inválida (terminal).
 * - Devolve 'WAIT' quando a referência existe mas ainda não foi processada (PENDING / PENDING_REFERENCE).
 */
export function validateReference(tx: WagerTransaction, ref: WagerTransaction): ReferenceResolution {
  if (
    ref.playerId !== tx.playerId ||
    ref.walletId !== tx.walletId ||
    ref.money.currency !== tx.money.currency ||
    ref.roundId !== tx.roundId ||
    ref.providerId !== tx.providerId
  ) {
    throw new BusinessRuleViolation(FailureCode.ReferenceMismatch);
  }

  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(ref.kind)) throw new BusinessRuleViolation(FailureCode.InvalidReferenceKind);

  if (ref.status === WagerTransactionStatus.Pending || ref.status === WagerTransactionStatus.PendingReference) {
    return 'WAIT';
  }
  if (ref.status !== WagerTransactionStatus.Processed) {
    throw new BusinessRuleViolation(FailureCode.ReferenceNotProcessed);
  }

  if (tx.requiresReference() && !tx.money.equals(ref.money)) {
    throw new BusinessRuleViolation(FailureCode.AmountMismatch);
  }
  return 'APPLICABLE';
}
