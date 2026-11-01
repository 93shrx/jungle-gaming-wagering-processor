/** Erros da camada de aplicação (o mapeamento para HTTP/SQS fica em `interface`). */
export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Mesma Idempotency-Key (ou mesmo providerId+externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(key: string) {
    super('IDEMPOTENCY_CONFLICT', `Idempotency key "${key}" was already used with a different payload`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super('WALLET_ALREADY_EXISTS', `Wallet already exists for player ${playerId} in ${currency}`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(what: string) {
    super('TRANSACTION_NOT_FOUND', `Transaction ${what} not found`);
  }
}

export class InvalidCursorError extends ApplicationError {
  constructor() {
    super('INVALID_CURSOR', 'Invalid cursor');
  }
}

/** Falha transitória de infraestrutura (deadlock, conexão, timeout…): reenviar é seguro. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super('TRANSIENT_INFRASTRUCTURE_FAILURE', message);
  }
}
