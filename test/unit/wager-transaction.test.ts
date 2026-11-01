import { describe, expect, test } from 'bun:test';
import {
  BusinessRuleViolation,
  InvalidLedgerEntryError,
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-codes';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { computePayloadHash } from '../../src/domain/payload-hash';
import { validateReference } from '../../src/domain/reference-rules';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');

function tx(over: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 't1', providerId: 'pa', externalTransactionId: 'x1', idempotencyKey: 'pa:x1', payloadHash: 'h',
    walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g', kind: K.Bet, money: brl('25.00'),
    createdAt: at, ...over,
  });
}
const processed = (over: Partial<CreateWagerTransactionProps> = {}) => {
  const t = tx(over);
  t.markProcessed(undefined, at, brl('0.00'));
  return t;
};

describe('WagerTransaction', () => {
  test('nasce PENDING', () => {
    expect(tx().status).toBe(S.Pending);
  });

  test('OPENING não pode ser submetido externamente', () => {
    expect(() => tx({ kind: K.Opening })).toThrow(InvalidTransactionError);
    expect(tx({ kind: K.Opening, internal: true }).kind).toBe(K.Opening);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => tx({ kind: K.Refund })).toThrow(InvalidTransactionError);
    expect(() => tx({ kind: K.Rollback })).toThrow(InvalidTransactionError);
    expect(tx({ kind: K.Refund, referenceExternalTransactionId: 'x0' }).requiresReference()).toBe(true);
    expect(() => tx({ kind: K.Bet, referenceExternalTransactionId: 'x0' })).toThrow(InvalidTransactionError);
  });

  test('valor deve ser positivo', () => {
    expect(() => tx({ money: brl('0.00') })).toThrow(InvalidTransactionError);
  });

  test('transições válidas', () => {
    const a = tx(); a.markPendingReference(at); expect(a.status).toBe(S.PendingReference);
    a.markPendingReference(at); expect(a.pendingAttempts).toBe(1);
    a.markProcessed('ref', at); expect(a.status).toBe(S.Processed);
    const b = tx(); b.reject(FailureCode.InsufficientFunds); expect(b.status).toBe(S.Rejected);
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);
    const c = tx(); c.fail(FailureCode.InternalFailure); expect(c.status).toBe(S.Failed);
  });

  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, at)],
    ['markPendingReference', (t: WagerTransaction) => t.markPendingReference()],
    ['reject', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InternalFailure)],
  ])('estado terminal não transiciona (%s)', (_n, fn) => {
    for (const terminate of [
      (t: WagerTransaction) => t.markProcessed(undefined, at),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds),
      (t: WagerTransaction) => t.fail(FailureCode.InternalFailure),
    ]) {
      const t = tx();
      terminate(t);
      expect(t.isTerminal()).toBe(true);
      expect(() => fn(t)).toThrow(InvalidTransactionStateError);
    }
  });

  test('affectsBalance e direção do ledger', () => {
    expect(tx({ kind: K.Loss }).affectsBalance()).toBe(false);
    expect(tx().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: K.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => tx({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
    const bet = tx();
    const win = tx({ kind: K.Win });
    const rbBet = tx({ kind: K.Rollback, referenceExternalTransactionId: 'x' });
    expect(rbBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rbBet.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rbBet.ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('matchesPayload', () => {
    expect(tx().matchesPayload('h')).toBe(true);
    expect(tx().matchesPayload('other')).toBe(false);
  });
});

describe('payloadHash', () => {
  const base = {
    providerId: 'pa', externalTransactionId: 'x1', playerId: 'p1', walletId: 'w1', roundId: 'r1', gameId: 'g',
    kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  };
  test('independe da ordem das chaves e da escala do valor', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25' }, kind: 'BET', gameId: 'g', roundId: 'r1', walletId: 'w1',
      playerId: 'p1', externalTransactionId: 'x1', providerId: 'pa',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });
  test('muda quando um campo de negócio muda', () => {
    expect(computePayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(computePayloadHash(base));
    expect(computePayloadHash({ ...base, roundId: 'r2' })).not.toBe(computePayloadHash(base));
  });
  test('referência ausente equivale a null', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: null })).toBe(computePayloadHash(base));
  });
});

describe('LedgerEntry', () => {
  const mk = (over = {}) => ({
    id: 'e', walletId: 'w', transactionId: 't', direction: LedgerDirection.Debit, money: brl('10.00'),
    balanceBefore: brl('30.00'), balanceAfter: brl('20.00'), createdAt: at, ...over,
  });
  test('valida aritmética na factory', () => {
    expect(WalletLedgerEntry.create(mk()).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create(mk({ balanceAfter: brl('21.00') }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(mk({ money: brl('0.00'), balanceAfter: brl('30.00') }))).toThrow(InvalidLedgerEntryError);
  });
  test('é estruturalmente imutável (sem setters/transições)', () => {
    const e = WalletLedgerEntry.create(mk());
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(e)).sort()).toEqual(['constructor', 'isBalanced']);
  });
});

describe('validateReference', () => {
  const bet = () => processed();
  test('REFUND de BET processada é aplicável', () => {
    const rf = tx({ id: 't2', kind: K.Refund, referenceExternalTransactionId: 'x1' });
    expect(validateReference(rf, bet())).toBe('APPLICABLE');
  });
  test('referência ainda pendente => WAIT', () => {
    const rf = tx({ id: 't2', kind: K.Refund, referenceExternalTransactionId: 'x1' });
    expect(validateReference(rf, tx())).toBe('WAIT');
  });
  const rule = (fn: () => unknown, code: FailureCode) => {
    try { fn(); } catch (e) { expect(e).toBeInstanceOf(BusinessRuleViolation); expect((e as BusinessRuleViolation).failureCode).toBe(code); return; }
    throw new Error('expected violation');
  };
  test('mismatch de player/wallet/rodada/moeda', () => {
    const rf = (o = {}) => tx({ id: 't2', kind: K.Refund, referenceExternalTransactionId: 'x1', ...o });
    rule(() => validateReference(rf({ playerId: 'other' }), bet()), FailureCode.ReferenceMismatch);
    rule(() => validateReference(rf({ walletId: 'other' }), bet()), FailureCode.ReferenceMismatch);
    rule(() => validateReference(rf({ roundId: 'other' }), bet()), FailureCode.ReferenceMismatch);
    rule(() => validateReference(rf({ money: Money.from({ amount: '25.00', currency: 'USD' }) }), bet()), FailureCode.ReferenceMismatch);
  });
  test('kind inválido da referência', () => {
    const win = processed({ kind: K.Win });
    const rf = tx({ id: 't2', kind: K.Refund, referenceExternalTransactionId: 'x1' });
    rule(() => validateReference(rf, win), FailureCode.InvalidReferenceKind);
    const rb = tx({ id: 't2', kind: K.Rollback, referenceExternalTransactionId: 'x1' });
    rule(() => validateReference(rb, processed({ kind: K.Loss })), FailureCode.InvalidReferenceKind);
    expect(validateReference(rb, win)).toBe('APPLICABLE');
  });
  test('valor diferente e referência rejeitada', () => {
    const rf = tx({ id: 't2', kind: K.Refund, referenceExternalTransactionId: 'x1', money: brl('24.00') });
    rule(() => validateReference(rf, bet()), FailureCode.AmountMismatch);
    const rejected = tx(); rejected.reject(FailureCode.InsufficientFunds);
    rule(() => validateReference(tx({ id: 't2', kind: K.Refund, referenceExternalTransactionId: 'x1' }), rejected), FailureCode.ReferenceNotProcessed);
  });
});
