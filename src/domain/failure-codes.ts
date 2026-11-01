/**
 * Taxonomia de códigos de falha (estável; parte do contrato com provedores).
 *
 * Retentável = reenviar a mesma operação mais tarde pode ter sucesso.
 * Corrigir   = payload/dados precisam mudar antes de reenviar.
 * Desistir   = não adianta reenviar.
 */
export enum FailureCode {
  /** BET sem saldo. Retentável (após depósito). */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão produziria saldo negativo. Desistir / ação operacional. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Referência não apareceu dentro do limite de tentativas/TTL. Corrigir. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência pertence a outro provider/player/wallet/moeda/rodada. Corrigir. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND só referencia BET; ROLLBACK só BET/WIN/REFUND. Corrigir. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** A referência não está PROCESSED (ex.: foi rejeitada). Desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência já revertida por esse tipo de operação. Desistir. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Valor da reversão difere do valor da referência. Corrigir. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Moeda da operação difere da moeda da wallet. Corrigir. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet inexistente. Corrigir. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Wallet não pertence ao player informado. Corrigir. */
  PlayerMismatch = 'PLAYER_MISMATCH',
  /** Erro permanente de infraestrutura (status FAILED). Investigar. */
  InternalFailure = 'INTERNAL_FAILURE',
}
