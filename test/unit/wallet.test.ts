import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError } from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');
const open = (initial = '100.00') => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now });
const mv = (money: Money, n = 1) => ({ money, transactionId: `t${n}`, entryId: `e${n}`, at: now });

describe('Wallet', () => {
  test('abre com version 1 e saldo inicial', () => {
    const w = open();
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  test('openingEntry gera CREDIT balanceado; wallet zerada não gera', () => {
    const e = open().openingEntry({ transactionId: 't0', entryId: 'e0', at: now })!;
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.balanceBefore.amount).toBe('0.00');
    expect(e.balanceAfter.amount).toBe('100.00');
    expect(open('0.00').openingEntry({ transactionId: 't0', entryId: 'e0', at: now })).toBeUndefined();
  });

  test('debit reduz saldo, incrementa version e devolve lançamento balanceado', () => {
    const w = open();
    const e = w.debit(mv(brl('80.00')));
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.isBalanced()).toBe(true);
    expect(e.balanceBefore.amount).toBe('100.00');
    expect(e.balanceAfter.amount).toBe('20.00');
  });

  test('credit aumenta saldo', () => {
    const w = open();
    w.credit(mv(brl('5.50')));
    expect(w.balance.amount).toBe('105.50');
    expect(w.version).toBe(2);
  });

  test('saldo nunca fica negativo; falha não altera estado', () => {
    const w = open();
    w.debit(mv(brl('80.00')));
    expect(() => w.debit(mv(brl('80.00'), 2))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(2);
  });

  test('debitar exatamente o saldo é permitido', () => {
    const w = open();
    w.debit(mv(brl('100.00')));
    expect(w.balance.isZero()).toBe(true);
  });

  test('conflito de moeda', () => {
    const w = open();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => w.debit(mv(usd))).toThrow(CurrencyMismatchError);
    expect(() => w.credit(mv(usd))).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('rehydrate não revalida', () => {
    const w = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: 'BRL', balance: brl('7.00'), version: 9, createdAt: now, updatedAt: now,
    });
    expect(w.version).toBe(9);
  });
});
