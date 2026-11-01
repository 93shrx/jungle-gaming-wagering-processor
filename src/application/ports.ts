import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';

// ----------------------------------------------------------------- tokens de DI
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const READ_REPOSITORIES = Symbol('READ_REPOSITORIES');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const METRICS = Symbol('METRICS');
export const APP_LOGGER = Symbol('APP_LOGGER');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const PENDING_REFERENCE_POLICY = Symbol('PENDING_REFERENCE_POLICY');
export const HEALTH_PROBES = Symbol('HEALTH_PROBES');

// ------------------------------------------------------------------- utilidades
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export type MetricName =
  | 'wager_transactions_total' // labels: status, kind
  | 'wager_duplicates_total' // labels: source
  | 'wager_idempotency_conflicts_total'
  | 'wager_retries_total' // labels: component
  | 'wager_dlq_messages_total'
  | 'wager_lock_conflicts_total'
  | 'wager_reconciliation_divergences_total'
  | 'wager_outbox_published_total'
  | 'wager_outbox_publish_failures_total'
  | 'wager_processing_duration_seconds' // histogram
  | 'wager_outbox_lag_seconds' // gauge
  | 'wager_outbox_pending' // gauge
  | 'wager_pending_reference' // gauge
  | 'wager_sqs_messages_total'; // labels: outcome

export interface Metrics {
  increment(name: MetricName, labels?: Record<string, string>, value?: number): void;
  observe(name: MetricName, value: number, labels?: Record<string, string>): void;
  gauge(name: MetricName, value: number): void;
}

export interface AppLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------- repositórios
export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT … FOR NO KEY UPDATE: lock de linha da wallet (unidade de concorrência). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** false quando já existe wallet para (playerId, currency). */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  /** Persiste saldo/version. `expectedVersion` é a rede de segurança otimista (lock já seguro). */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** INSERT … ON CONFLICT DO NOTHING (cobre idempotency_key e provider+external). */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | null>;
  /** Uma consulta só: por idempotency key (prioridade) ou por (provider, external id). */
  findExisting(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  save(tx: WagerTransaction): Promise<void>;
  /** REFUND/ROLLBACK já PROCESSED que revertem `referenceTransactionId`. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null>;
  /** Lock (SKIP LOCKED) da próxima PENDING_REFERENCE vencida. */
  lockNextDuePendingReference(now: Date): Promise<WagerTransaction | null>;
  /** Antecipa o reprocessamento das dependentes de uma referência recém-aplicada (sem esperar locks). */
  wakePendingDependents(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<void>;
  countPendingReference(): Promise<number>;
}

export interface LedgerCursorPage {
  items: WalletLedgerEntry[];
  /** cursor opaco da próxima página; null no fim */
  nextCursor: string | null;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  list(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerCursorPage>;
  /** Saldo armazenado e saldo recalculado pelo ledger lidos no MESMO snapshot (um único statement). */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface InboxRepository {
  /** false quando (consumerName, messageId) já foi recebido. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}

export interface OutboxRepository {
  /** INSERT multi-linha: um round-trip por transação financeira. */
  addAll(messages: OutboxMessage[]): Promise<void>;
  /** Lock (SKIP LOCKED) de mensagens pendentes e vencidas: vários publishers concorrentes. */
  lockDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage, lastError?: string): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestLagSeconds: number }>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/** Fronteira da transação SQL: tudo dentro de `run` confirma junto ou nada é confirmado. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

// ------------------------------------------------------------- mensageria/saúde
export interface EventPublisher {
  /** Publica um lote; devolve, por id, `undefined` (ok) ou a mensagem de erro. */
  publish(messages: OutboxMessage[]): Promise<Map<string, string | undefined>>;
}

export interface HealthProbes {
  database(): Promise<void>;
  queue(): Promise<void>;
}

export interface PendingReferencePolicy {
  maxAttempts: number;
  ttlMs: number;
  baseBackoffMs: number;
  capBackoffMs: number;
  batchSize: number;
}
