import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuid } from 'uuid';
import { TransientInfrastructureError } from '../../src/application/errors';
import { createApp } from '../../src/app.module';
import { loadConfig } from '../../src/config';
import { AllExceptionsFilter } from '../../src/interface/http/http-support';
import { SilentLogger } from '../../src/infrastructure/observability/pino-logger';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  // sem papéis de background: só a API HTTP
  app = await createApp({ ...loadConfig({ ...process.env, ROLE: 'http' }), roles: new Set(['http']) });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

const jsonOf = async (r: Response): Promise<any> => r.json();
const json = { 'content-type': 'application/json' };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });

async function wallet(amount = '1000.00') {
  const res = await post('/wallets', { playerId: `p-${uuid()}`, initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return (await jsonOf(res)) as { id: string; playerId: string; balance: { amount: string }; version: number };
}
const txBody = (w: { id: string; playerId: string }, over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: `tx-${uuid()}`,
  playerId: w.playerId,
  walletId: w.id,
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});
const submit = (body: any, key = `${body.providerId}:${body.externalTransactionId}`) =>
  post('/wagering/transactions', body, { 'Idempotency-Key': key });

describe('contrato HTTP', () => {
  test('POST /wallets => 201 e formato do contrato; duplicada => 409', async () => {
    const w = await wallet();
    expect(w).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const dup = await post('/wallets', { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect((await jsonOf(dup)).error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('POST /wagering/transactions: 200 processada, replay idempotente, 409 conflito', async () => {
    const w = await wallet();
    const body = txBody(w);
    const r1 = await submit(body);
    expect(r1.status).toBe(200);
    expect(await jsonOf(r1)).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    const r2 = await submit(body);
    expect(r2.status).toBe(200);
    expect(await jsonOf(r2)).toMatchObject({ idempotentReplay: true });
    const conflict = await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect((await jsonOf(conflict)).error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  test('400: header ausente, JSON inválido, Money inválido, campo extra, kind inválido/OPENING, UUID inválido', async () => {
    const w = await wallet();
    const noKey = await post('/wagering/transactions', txBody(w));
    expect(noKey.status).toBe(400);
    for (const bad of [
      txBody(w, { money: { amount: '1e3', currency: 'BRL' } }),
      txBody(w, { money: { amount: 25, currency: 'BRL' } }),
      txBody(w, { money: { amount: '-1.00', currency: 'BRL' } }),
      txBody(w, { money: { amount: '1.001', currency: 'BRL' } }),
      txBody(w, { kind: 'OPENING' }),
      txBody(w, { kind: 'NOPE' }),
      txBody(w, { kind: 'REFUND' }),
      txBody(w, { walletId: 'not-a-uuid' }),
      txBody(w, { providerId: '__system__' }),
      { ...txBody(w), surprise: true },
    ]) {
      const res = await submit(bad);
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error.retryable).toBe(false);
    }
    const garbage = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers: { ...json, 'Idempotency-Key': 'k' }, body: '{nope' });
    expect(garbage.status).toBe(400);
  });

  test('422: rejeição de negócio com failureCode estável; replay também 422', async () => {
    const w = await wallet('10.00');
    const body = txBody(w, { money: { amount: '80.00', currency: 'BRL' } });
    const res = await submit(body);
    expect(res.status).toBe(422);
    expect(await jsonOf(res)).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', error: { code: 'INSUFFICIENT_FUNDS', retryable: false } });
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(await jsonOf(replay)).toMatchObject({ idempotentReplay: true });
  });

  test('202: referência ausente => aceita com processamento pendente', async () => {
    const w = await wallet();
    const res = await submit(txBody(w, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(await jsonOf(res)).toMatchObject({ status: 'PENDING_REFERENCE', balance: null });
  });

  test('404: wallet/transação inexistente; consultas por id e por provider+external', async () => {
    const w = await wallet();
    expect((await fetch(`${base}/wallets/${uuid()}`)).status).toBe(404);
    expect((await fetch(`${base}/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await fetch(`${base}/wallets/not-uuid`)).status).toBe(400);
    expect((await submit(txBody({ id: uuid(), playerId: 'x' }))).status).toBe(404);

    const body = txBody(w);
    const created = await jsonOf(await submit(body));
    const byId = await jsonOf(await fetch(`${base}/wagering/transactions/${created.transactionId}`));
    const byExt = await jsonOf(await fetch(`${base}/providers/provider-a/wagering/transactions/${body.externalTransactionId}`));
    expect(byId).toMatchObject({ id: created.transactionId, status: 'PROCESSED', kind: 'BET' });
    expect(byExt.id).toBe(created.transactionId);
  });

  test('GET /wallets/:id/ledger: cursor opaco e estável, sem repetir nem pular entradas', async () => {
    const w = await wallet('1000.00');
    for (let i = 0; i < 7; i++) await submit(txBody(w, { money: { amount: '1.00', currency: 'BRL' } }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `${base}/wallets/${w.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page: any = await jsonOf(await fetch(url));
      seen.push(...page.items.map((i: any) => i.id));
      cursor = page.nextCursor;
      pages++;
      // novas entradas durante a paginação não podem quebrar o cursor
      if (pages === 1) await submit(txBody(w, { money: { amount: '1.00', currency: 'BRL' } }));
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(9); // opening + 7 + 1 durante a paginação
    expect((await fetch(`${base}/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await fetch(`${base}/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
  });

  test('POST /wallets/:id/reconciliation', async () => {
    const w = await wallet();
    await submit(txBody(w));
    const res = await post(`/wallets/${w.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      walletId: w.id,
      storedBalance: { amount: '975.00' },
      calculatedBalance: { amount: '975.00' },
      difference: { amount: '0.00' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada (nunca corrigida) — saldo adulterado via SQL com trigger desligado', async () => {
    const { MikroORM } = await import('@mikro-orm/postgresql');
    const { buildOrmConfig } = await import('../../src/infrastructure/persistence/orm-config');
    const w = await wallet();
    const orm = await MikroORM.init(buildOrmConfig({ poolMax: 2 }));
    try {
      await orm.em.fork().transactional(async (em) => {
        await em.execute(`ALTER TABLE wallets DISABLE TRIGGER trg_wallet_balance_matches_ledger`, [], 'run');
        await em.execute(`UPDATE wallets SET balance = balance + 1 WHERE id = ?`, [w.id], 'run');
        await em.execute(`ALTER TABLE wallets ENABLE TRIGGER trg_wallet_balance_matches_ledger`, [], 'run');
      });
      const res = await post(`/wallets/${w.id}/reconciliation`, {});
      expect(await jsonOf(res)).toMatchObject({ consistent: false, difference: { amount: '1.00' } });
      const metrics = await (await fetch(`${base}/metrics`)).text();
      expect(metrics).toMatch(/wager_reconciliation_divergences_total [1-9]/);
      // não foi corrigido
      expect((await jsonOf(await fetch(`${base}/wallets/${w.id}`))).balance.amount).toBe('1001.00');
    } finally {
      await orm.close();
    }
  });

  test('health: live e ready abertos; /metrics expõe as métricas exigidas', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await jsonOf(ready)).toMatchObject({ database: 'up', queue: 'up' });
    const metrics = await (await fetch(`${base}/metrics`)).text();
    for (const m of [
      'wager_transactions_total', 'wager_duplicates_total', 'wager_retries_total', 'wager_dlq_messages_total',
      'wager_lock_conflicts_total', 'wager_outbox_lag_seconds', 'wager_processing_duration_seconds',
    ]) {
      expect(metrics).toContain(m);
    }
  });

  test('x-correlation-id é propagado/gerado', async () => {
    const res = await fetch(`${base}/health/live`, { headers: { 'x-correlation-id': 'abc-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
    expect((await fetch(`${base}/health/live`)).headers.get('x-correlation-id')).toBeTruthy();
  });
});

describe('falha transitória de infraestrutura', () => {
  test('TransientInfrastructureError => 503 retryable com Retry-After', () => {
    const filter = new AllExceptionsFilter(new SilentLogger());
    const captured: any = { headers: {} };
    const res = {
      setHeader: (k: string, v: string) => (captured.headers[k] = v),
      status: (s: number) => ({ json: (b: unknown) => Object.assign(captured, { status: s, body: b }) }),
    };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ correlationId: 'c', path: '/x' }) }) };
    filter.catch(new TransientInfrastructureError('db down'), host);
    expect(captured.status).toBe(503);
    expect(captured.headers['Retry-After']).toBe('1');
    expect(captured.body.error).toMatchObject({ code: 'TRANSIENT_INFRASTRUCTURE_FAILURE', retryable: true });
  });
});
