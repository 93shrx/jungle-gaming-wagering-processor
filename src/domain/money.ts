import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string; // decimal string, escala fixa 2, ex.: "25.00"
  currency: string; // ISO-4217
}

const INPUT_RE = /^\d+(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Internamente guarda centavos (escala 2) em bigint:
 * aritmética exata, sem float. O domínio não depende de tipos do ORM.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: string decimal não negativa, até 2 casas. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? ({} as MoneyProps);
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: ${String(currency)}`);
    }
    if (typeof amount !== 'string' || amount.length === 0) {
      throw new InvalidMoneyError('Amount must be a non-empty decimal string');
    }
    if (!INPUT_RE.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount "${amount}": expected non-negative decimal with at most 2 fraction digits`,
      );
    }
    const [int, frac = ''] = amount.split('.') as [string, string?];
    return new Money(BigInt(int) * 100n + BigInt(frac.padEnd(2, '0')), currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_RE.test(currency)) throw new InvalidMoneyError(`Invalid currency: ${currency}`);
    return new Money(0n, currency);
  }

  /** Reidratação a partir da persistência: aceita o que já foi gravado (inclusive negativos, escala do NUMERIC). */
  static fromStored(amount: string, currency: string): Money {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
    if (!m) throw new InvalidMoneyError(`Corrupt stored amount: ${amount}`);
    const frac = (m[3] ?? '').padEnd(2, '0').slice(0, 2);
    const abs = Money.from({ amount: `${m[2]}.${frac}`, currency });
    return m[1] === '-' ? abs.negate() : abs;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  /** Decimal string com 2 casas, ex.: "-5.00". */
  get amount(): string {
    const neg = this.cents < 0n;
    const abs = neg ? -this.cents : this.cents;
    const int = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${neg ? '-' : ''}${int}.${frac}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
