import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { CreateWallet } from '../../src/application/create-wallet';
import type { PendingReferencePolicy } from '../../src/application/ports';
import { PublishOutbox } from '../../src/application/publish-outbox';
import { Queries } from '../../src/application/queries';
import { ReconcileWallet } from '../../src/application/reconcile-wallet';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import { SubmitWagerTransaction, type SubmitWagerTransactionCommand } from '../../src/application/submit-wager-transaction';
import { WagerTransactionProcessor } from '../../src/application/wager-transaction-processor';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/mikro-unit-of-work';
import { buildOrmConfig } from '../../src/infrastructure/persistence/orm-config';
import { SqlRepositories } from '../../src/infrastructure/persistence/sql-repositories';
import { PromMetrics } from '../../src/infrastructure/observability/prom-metrics';
import { SilentLogger } from '../../src/infrastructure/observability/pino-logger';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import type { EventPublisher } from '../../src/application/ports';

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager';

export const FAST_POLICY: PendingReferencePolicy = {
  maxAttempts: 5,
  ttlMs: 60_000,
  baseBackoffMs: 20,
  capBackoffMs: 100,
  batchSize: 100,
};

export interface HarnessOptions {
  policy?: Partial<PendingReferencePolicy>;
  publisher?: EventPublisher;
  poolMax?: number;
}

/** Composição manual (sem Nest) dos casos de uso contra PostgreSQL REAL. */
export async function createHarness(options: HarnessOptions = {}) {
  const orm = await MikroORM.init(buildOrmConfig({ clientUrl: TEST_DATABASE_URL, poolMax: options.poolMax ?? 20 }));
  await orm.migrator.up();
  const metrics = new PromMetrics(false);
  const logger = new SilentLogger();
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const policy = { ...FAST_POLICY, ...options.policy };
  const uow = new MikroUnitOfWork(orm, metrics);
  const readRepos = new SqlRepositories(orm.em.fork() as any);
  const processor = new WagerTransactionProcessor(ids, policy, metrics);
  const publisher: EventPublisher =
    options.publisher ?? { publish: async (msgs) => new Map(msgs.map((m) => [m.id, undefined])) };

  return {
    orm,
    metrics,
    uow,
    readRepos,
    submit: new SubmitWagerTransaction(uow, clock, ids, metrics, processor),
    createWallet: new CreateWallet(uow, clock, ids),
    queries: new Queries(readRepos),
    reconcile: new ReconcileWallet(readRepos, metrics, logger),
    reprocess: new ReprocessPendingReferences(uow, clock, ids, policy, processor),
    publishOutbox: new PublishOutbox(uow, clock, publisher, metrics, logger),
    close: () => orm.close(),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function newWallet(h: Harness, initial = '100.00') {
  return h.createWallet.execute({ playerId: `player-${uuidv7()}`, initialBalance: brl(initial), correlationId: uuidv7() });
}

export function cmd(
  wallet: { id: string; playerId: string },
  over: Partial<SubmitWagerTransactionCommand> & { providerId?: string; externalTransactionId?: string } = {},
): SubmitWagerTransactionCommand {
  const providerId = over.providerId ?? 'provider-a';
  const externalTransactionId = over.externalTransactionId ?? `tx-${uuidv7()}`;
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('10.00'),
    correlationId: uuidv7(),
    source: { type: 'http' },
    ...over,
  };
}

/** Invariante final de TODOS os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectLedgerConsistent(h: Harness, walletId: string) {
  const report = await h.reconcile.execute(walletId);
  expect(report.consistent).toBe(true);
  expect(report.storedBalance.amount).toBe(report.calculatedBalance.amount);
  // além da soma: a cadeia before/after do ledger é contínua
  const rows: any[] = await h.orm.em.fork().execute(
    `SELECT balance_before::text AS b, balance_after::text AS a FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq`,
    [walletId],
  );
  let prev = '0.00';
  for (const r of rows) {
    expect(r.b).toBe(prev);
    prev = r.a;
  }
  expect(prev).toBe(report.storedBalance.amount);
}

export async function countRows(h: Harness, sql: string, params: unknown[] = []): Promise<number> {
  const rows: any[] = await h.orm.em.fork().execute(sql, params);
  return Number(rows[0]?.c ?? 0);
}
