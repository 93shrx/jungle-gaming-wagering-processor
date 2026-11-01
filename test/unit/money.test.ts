import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com escala 2', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.07').toJSON()).toEqual({ amount: '0.07', currency: 'BRL' });
  });

  test('aritmética exata (sem float)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('1.00').subtract(brl('1.01')).amount).toBe('-0.01');
    expect(brl('5.00').negate().amount).toBe('-5.00');
    expect(brl('99999999999999999.99').add(brl('0.01')).amount).toBe('100000000000000000.00');
  });

  test('imutável', () => {
    const a = brl('10.00');
    a.add(brl('1.00'));
    expect(a.amount).toBe('10.00');
  });

  test.each(['', 'NaN', 'Infinity', '1e3', '1E3', '-1.00', '1.234', ' 1.00', '1,00', '.5', '1.', '0x10'])(
    'rejeita entrada inválida %p',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test('rejeita number e moeda inválida', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'br' })).toThrow(InvalidMoneyError);
  });

  test('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('predicados e comparação', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.10').equals(brl('1.1'))).toBe(true);
  });

  test('fromStored reidrata NUMERIC do banco', () => {
    expect(Money.fromStored('1000.0000', 'BRL').amount).toBe('1000.00');
    expect(Money.fromStored('-0.50', 'BRL').amount).toBe('-0.50');
  });
});
