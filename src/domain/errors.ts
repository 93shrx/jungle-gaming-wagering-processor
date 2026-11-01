import type { FailureCode } from './failure-codes';

/** Erro de regra de domínio. `code` é estável e legível por máquina. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: ${a} vs ${b}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Insufficient funds');
  }
}

/** Erro de programação: transição inválida a partir de estado terminal/incompatível. */
export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSACTION_STATE', `Invalid transition ${from} -> ${to}`);
  }
}

export class InvalidTransactionError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION', message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}

/** Rejeição de negócio carregando o failureCode que será persistido. */
export class BusinessRuleViolation extends DomainError {
  constructor(
    public readonly failureCode: FailureCode,
    message?: string,
  ) {
    super(failureCode, message ?? failureCode);
  }
}
