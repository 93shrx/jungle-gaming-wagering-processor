import type { SqlEntityManager } from '@mikro-orm/postgresql';
import { InvalidCursorError, TransientInfrastructureError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerCursorPage,
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import type { FailureCode } from '../../domain/failure-codes';
import type { InboxMessage } from '../../domain/inbox-message';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { Wallet } from '../../domain/wallet';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';

type Row = Record<string, any>;

/** timestamptz -> ISO-8601 UTC determinístico (o driver devolveria texto dependente da sessão). */
const ts = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const date = (v: unknown): Date => new Date(v as string);
const optDate = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : date(v));
const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

const WALLET_COLS = `id, player_id, currency, balance::text AS balance, version, ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at`;

const TX_COLS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount::text AS amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, observed_balance::text AS observed_balance, pending_attempts,
  ${ts('next_attempt_at')} AS next_attempt_at, ${ts('created_at')} AS created_at, ${ts('processed_at')} AS processed_at`;

function toWallet(r: Row): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency: r.currency,
    balance: Money.fromStored(r.balance, r.currency),
    version: Number(r.version),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  });
}

function toTransaction(r: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromStored(r.amount, r.currency),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    createdAt: date(r.created_at),
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    failureCode: (r.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: optDate(r.processed_at),
    observedBalance: r.observed_balance === null ? undefined : Money.fromStored(r.observed_balance, r.currency),
    pendingAttempts: Number(r.pending_attempts),
    nextAttemptAt: optDate(r.next_attempt_at),
  });
}

class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async findById(id: string) {
    const rows: Row[] = await this.em.execute(`SELECT ${WALLET_COLS} FROM wallets WHERE id = ?`, [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async findByIdForUpdate(id: string) {
    const rows: Row[] = await this.em.execute(`SELECT ${WALLET_COLS} FROM wallets WHERE id = ? FOR NO KEY UPDATE`, [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async insertIfAbsent(w: Wallet) {
    const rows: Row[] = await this.em.execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      [w.id, w.playerId, w.currency, w.balance.amount, w.version, w.createdAt, w.updatedAt],
    );
    return rows.length === 1;
  }

  async save(w: Wallet, expectedVersion: number) {
    const res: any = await this.em.execute(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
      [w.balance.amount, w.version, w.updatedAt, w.id, expectedVersion],
      'run',
    );
    if (res.affectedRows !== 1) {
      throw new TransientInfrastructureError(`optimistic check failed for wallet ${w.id} (expected v${expectedVersion})`);
    }
  }
}

class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insertIfAbsent(tx: WagerTransaction) {
    const rows: Row[] = await this.em.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         status, pending_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      [
        tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
        tx.roundId, tx.gameId, tx.kind, tx.money.amount, tx.money.currency, nn(tx.referenceExternalTransactionId),
        tx.status, tx.pendingAttempts, tx.createdAt,
      ],
    );
    return rows.length === 1;
  }

  private async one(where: string, params: unknown[]) {
    const rows: Row[] = await this.em.execute(`SELECT ${TX_COLS} FROM wager_transactions WHERE ${where}`, params);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  findById(id: string) {
    return this.one('id = ?', [id]);
  }
  findByProviderExternal(providerId: string, externalTransactionId: string) {
    return this.one('provider_id = ? AND external_transaction_id = ?', [providerId, externalTransactionId]);
  }
  async findExisting(idempotencyKey: string, providerId: string, externalTransactionId: string) {
    const rows: Row[] = await this.em.execute(
      `SELECT ${TX_COLS} FROM wager_transactions
        WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?)
        ORDER BY (idempotency_key = ?) DESC LIMIT 1`,
      [idempotencyKey, providerId, externalTransactionId, idempotencyKey],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }
  findProcessedReversalOf(referenceTransactionId: string) {
    return this.one(`reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`, [
      referenceTransactionId,
    ]);
  }

  async save(tx: WagerTransaction) {
    await this.em.execute(
      `UPDATE wager_transactions SET status = ?, reference_transaction_id = ?, failure_code = ?,
         observed_balance = ?, pending_attempts = ?, next_attempt_at = ?, processed_at = ? WHERE id = ?`,
      [
        tx.status, nn(tx.referenceTransactionId), nn(tx.failureCode), nn(tx.observedBalance?.amount),
        tx.pendingAttempts, nn(tx.nextAttemptAt), nn(tx.processedAt), tx.id,
      ],
      'run',
    );
  }

  async lockNextDuePendingReference(now: Date) {
    const rows: Row[] = await this.em.execute(
      `SELECT ${TX_COLS} FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async wakePendingDependents(providerId: string, referenceExternalTransactionId: string, now: Date) {
    // SKIP LOCKED: nunca esperamos por uma linha que outro worker já está processando (evita deadlock).
    await this.em.execute(
      `UPDATE wager_transactions SET next_attempt_at = ?
        WHERE id IN (SELECT id FROM wager_transactions
                      WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
                      FOR UPDATE SKIP LOCKED)`,
      [now, providerId, referenceExternalTransactionId],
      'run',
    );
  }

  async countPendingReference() {
    const rows: Row[] = await this.em.execute(
      `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
    );
    return Number(rows[0]?.c ?? 0);
  }
}

const encodeCursor = (seq: string) => Buffer.from(`v1:${seq}`).toString('base64url');
function decodeCursor(cursor: string): string {
  const m = /^v1:(\d{1,18})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m) throw new InvalidCursorError();
  return m[1]!;
}

class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async append(e: WalletLedgerEntry) {
    await this.em.execute(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
         balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id, e.walletId, e.transactionId, e.direction, e.money.amount, e.money.currency,
        e.balanceBefore.amount, e.balanceAfter.amount, e.createdAt,
      ],
      'run',
    );
  }

  async list(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerCursorPage> {
    const after = cursor ? decodeCursor(cursor) : '0';
    const rows: Row[] = await this.em.execute(
      `SELECT seq::text AS seq, id, wallet_id, transaction_id, direction, amount::text AS amount, currency,
              balance_before::text AS balance_before, balance_after::text AS balance_after,
              ${ts('created_at')} AS created_at
         FROM wallet_ledger_entries WHERE wallet_id = ? AND seq > ?::bigint ORDER BY seq ASC LIMIT ?`,
      [walletId, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) =>
        WalletLedgerEntry.rehydrate({
          id: r.id,
          walletId: r.wallet_id,
          transactionId: r.transaction_id,
          direction: r.direction as LedgerDirection,
          money: Money.fromStored(r.amount, r.currency),
          balanceBefore: Money.fromStored(r.balance_before, r.currency),
          balanceAfter: Money.fromStored(r.balance_after, r.currency),
          createdAt: date(r.created_at),
        }),
      ),
      nextCursor: rows.length > limit && last ? encodeCursor(last.seq) : null,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | null> {
    // Um único statement => um único snapshot: saldo armazenado e ledger não podem divergir por corrida de leitura.
    const rows: Row[] = await this.em.execute(
      `SELECT w.balance::text AS stored, w.currency,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated,
              COUNT(l.id)::int AS entries
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      storedBalance: Money.fromStored(r.stored, r.currency),
      calculatedBalance: Money.fromStored(r.calculated, r.currency),
      entries: Number(r.entries),
    };
  }
}

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async tryReceive(m: InboxMessage) {
    const rows: Row[] = await this.em.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt],
    );
    return rows.length === 1;
  }

  async markProcessed(consumerName: string, messageId: string, at: Date) {
    await this.em.execute(
      `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`,
      [at, consumerName, messageId],
      'run',
    );
  }
}

class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async addAll(messages: OutboxMessage[]) {
    if (messages.length === 0) return;
    const values = messages.map(() => '(?, ?, ?, ?::jsonb, ?, ?, ?)').join(', ');
    await this.em.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ${values}`,
      messages.flatMap((m) => [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, nn(m.nextAttemptAt)]),
      'run',
    );
  }

  async lockDue(now: Date, limit: number) {
    const rows: Row[] = await this.em.execute(
      `SELECT id, aggregate_id, event_type, payload, ${ts('occurred_at')} AS occurred_at, attempts,
              ${ts('next_attempt_at')} AS next_attempt_at, ${ts('published_at')} AS published_at
         FROM outbox_messages
        WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY occurred_at, id LIMIT ? FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        occurredAt: date(r.occurred_at),
        attempts: Number(r.attempts),
        nextAttemptAt: optDate(r.next_attempt_at),
        publishedAt: optDate(r.published_at),
      }),
    );
  }

  async save(m: OutboxMessage, lastError?: string) {
    await this.em.execute(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, published_at = ?, last_error = ? WHERE id = ?`,
      [m.attempts, nn(m.nextAttemptAt), nn(m.publishedAt), nn(lastError), m.id],
      'run',
    );
  }

  async stats(now: Date) {
    const rows: Row[] = await this.em.execute(
      `SELECT COUNT(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at))), 0)::float8 AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    return { pending: Number(rows[0]?.pending ?? 0), oldestLagSeconds: Math.max(0, Number(rows[0]?.lag ?? 0)) };
  }
}

/** Todos os repositórios ligados ao mesmo EntityManager (= mesma transação SQL quando dentro de `transactional`). */
export class SqlRepositories implements Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: SqlEntityManager) {
    this.wallets = new SqlWalletRepository(em);
    this.transactions = new SqlWagerTransactionRepository(em);
    this.ledger = new SqlLedgerRepository(em);
    this.inbox = new SqlInboxRepository(em);
    this.outbox = new SqlOutboxRepository(em);
  }
}
