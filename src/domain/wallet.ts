import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/** Aggregate root. Toda mudança de saldo devolve o lançamento de ledger correspondente. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre a wallet já com o saldo inicial (version = 1). O lançamento OPENING sai de `openingEntry`. */
  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvalidMoneyError('Initial balance must not be negative');
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lançamento CREDIT de abertura (saldo anterior zero). Não altera o estado da wallet. */
  openingEntry(props: { transactionId: string; entryId: string; at: Date }): WalletLedgerEntry | undefined {
    if (!this._balance.isPositive()) return undefined;
    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: this._balance.subtract(this._balance),
      balanceAfter: this._balance,
      createdAt: props.at,
    });
  }

  debit(p: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(p.money);
    if (this._balance.isLessThan(p.money)) throw new InsufficientFundsError();
    return this.apply(LedgerDirection.Debit, p);
  }

  credit(p: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(p.money);
    return this.apply(LedgerDirection.Credit, p);
  }

  private apply(direction: LedgerDirection, p: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(p.money) : before.subtract(p.money);
    const entry = WalletLedgerEntry.create({
      id: p.entryId,
      walletId: this.id,
      transactionId: p.transactionId,
      direction,
      money: p.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: p.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = p.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
