import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { v7 as uuid } from 'uuid';
import { TransientInfrastructureError } from '../../src/application/errors';
import { SqsConsumer, classifyError, MalformedMessageError } from '../../src/infrastructure/messaging/sqs-consumer';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SilentLogger } from '../../src/infrastructure/observability/pino-logger';
import { brl, countRows, createHarness, expectLedgerConsistent, newWallet, type Harness } from '../helpers/harness';
import { createTestQueues, requestedMessage, waitFor } from '../helpers/sqs';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ poolMax: 30 });
});
afterAll(async () => {
  await h.close();
});

const logger = new SilentLogger();
const debits = (walletId: string) =>
  countRows(h, `SELECT COUNT(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]);
const consumerOf = (q: Awaited<ReturnType<typeof createTestQueues>>, submit = h.submit) =>
  new SqsConsumer(q.sqs, submit, q.config, h.metrics, logger);

describe('classificação de erros', () => {
  test('negócio => ack; permanente => DLQ; transitório/desconhecido => retry', () => {
    expect(classifyError(new MalformedMessageError('x')).disposition).toBe('dead-letter');
    expect(classifyError(new TransientInfrastructureError('db')).disposition).toBe('retry');
    expect(classifyError(new Error('boom')).disposition).toBe('retry');
  });
});

describe('consumidor SQS (LocalStack real)', () => {
  test('processa, só então faz ack, e grava inbox', async () => {
    const q = await createTestQueues();
    const w = await newWallet(h, '100.00');
    const msg = requestedMessage(w, { amount: '30.00' });
    const consumer = consumerOf(q);
    consumer.start();
    try {
      await q.send(msg, w.id);
      await waitFor(async () => (await debits(w.id)) === 1);
      await waitFor(async () => (await q.depth(q.mainUrl)).visible + (await q.depth(q.mainUrl)).inFlight === 0);
    } finally {
      await consumer.stop();
    }
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('70.00'));
    expect(await countRows(h, `SELECT COUNT(*)::int AS c FROM inbox_messages WHERE message_id = ? AND processed_at IS NOT NULL`, [msg.messageId])).toBe(1);
    await expectLedgerConsistent(h, w.id);
  }, 60_000);

  test('redelivery/duplicatas (mesmo messageId e mesma idempotency key) não duplicam o efeito', async () => {
    const q = await createTestQueues();
    const w = await newWallet(h, '100.00');
    const msg = requestedMessage(w, { amount: '40.00' });
    const consumer = consumerOf(q);
    consumer.start();
    try {
      // dedupIds diferentes: o broker NÃO deduplica; quem garante é o inbox/banco
      await q.send(msg, w.id, uuid());
      await q.send(msg, w.id, uuid());
      await q.send({ ...msg, messageId: `other-${uuid()}` }, w.id, uuid()); // outro messageId, mesma key
      await waitFor(async () => (await q.depth(q.mainUrl)).visible + (await q.depth(q.mainUrl)).inFlight === 0 && (await debits(w.id)) >= 1);
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await consumer.stop();
    }
    expect(await debits(w.id)).toBe(1);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('60.00'));
    await expectLedgerConsistent(h, w.id);
  }, 60_000);

  test('erro de NEGÓCIO: rejeição é persistida e a mensagem é confirmada (ack), sem DLQ', async () => {
    const q = await createTestQueues();
    const w = await newWallet(h, '5.00');
    const msg = requestedMessage(w, { amount: '80.00' });
    const consumer = consumerOf(q);
    consumer.start();
    try {
      await q.send(msg, w.id);
      await waitFor(async () => (await h.queries.getTransactionByExternalId('provider-a', msg.data.externalTransactionId).catch(() => null))?.status === 'REJECTED');
      await waitFor(async () => (await q.depth(q.mainUrl)).visible + (await q.depth(q.mainUrl)).inFlight === 0);
    } finally {
      await consumer.stop();
    }
    const view = await h.queries.getTransactionByExternalId('provider-a', msg.data.externalTransactionId);
    expect(view.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await q.receiveAll(q.dlqUrl, 800)).length).toBe(0);
    await expectLedgerConsistent(h, w.id);
  }, 60_000);

  test('erro PERMANENTE (payload inválido) vai direto para a DLQ', async () => {
    const q = await createTestQueues();
    const w = await newWallet(h, '5.00');
    const before = await h.metrics.registry.getSingleMetricAsString('wager_dlq_messages_total');
    const consumer = consumerOf(q);
    consumer.start();
    try {
      await q.send('{not json', 'g1');
      await q.send({ ...requestedMessage(w), type: 'SomethingElse' }, 'g2');
      await q.send(requestedMessage(w, { amount: '1.001' }), 'g3'); // Money inválido
      await q.send(requestedMessage(w, { kind: 'OPENING' }), 'g4'); // OPENING não pode vir pela fila
      await waitFor(async () => (await q.depth(q.dlqUrl)).visible >= 4, 30_000);
    } finally {
      await consumer.stop();
    }
    const dead = await q.receiveAll(q.dlqUrl, 800);
    expect(dead.length).toBe(4);
    expect(dead.every((m) => m.MessageAttributes?.failureReason?.StringValue)).toBe(true);
    expect((await q.depth(q.mainUrl)).visible).toBe(0);
    expect(await h.metrics.registry.getSingleMetricAsString('wager_dlq_messages_total')).not.toBe(before);
    expect(await countRows(h, `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'`, [w.id])).toBe(0);
  }, 90_000);

  test('erro TRANSITÓRIO: retry com backoff e, ao atingir o limite de tentativas, DLQ', async () => {
    const q = await createTestQueues({ maxReceiveCount: 3, visibilityTimeout: 1 });
    const w = await newWallet(h, '50.00');
    let calls = 0;
    const flaky = { execute: async () => { calls++; throw new TransientInfrastructureError('postgres unavailable'); } } as any;
    const consumer = consumerOf(q, flaky);
    consumer.start();
    try {
      await q.send(requestedMessage(w), w.id);
      await waitFor(async () => (await q.depth(q.dlqUrl)).visible === 1, 45_000);
    } finally {
      await consumer.stop();
    }
    expect(calls).toBe(3); // exatamente maxReceiveCount tentativas
    expect((await q.depth(q.mainUrl)).visible).toBe(0);
    expect(await debits(w.id)).toBe(0);
  }, 90_000);

  test('infra volta durante os retries: mensagem acaba processada uma única vez', async () => {
    const q = await createTestQueues({ maxReceiveCount: 5, visibilityTimeout: 1 });
    const w = await newWallet(h, '100.00');
    let calls = 0;
    const recovering = {
      execute: async (c: any) => {
        if (++calls <= 2) throw new TransientInfrastructureError('blip');
        return h.submit.execute(c);
      },
    } as any;
    const consumer = consumerOf(q, recovering);
    consumer.start();
    try {
      await q.send(requestedMessage(w, { amount: '10.00' }), w.id);
      await waitFor(async () => (await debits(w.id)) === 1, 45_000);
    } finally {
      await consumer.stop();
    }
    expect(calls).toBe(3);
    expect((await q.depth(q.dlqUrl)).visible).toBe(0);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('90.00'));
  }, 90_000);

  test('falha no ack (depois do commit): redelivery não duplica o débito', async () => {
    const q = await createTestQueues({ visibilityTimeout: 2 });
    const w = await newWallet(h, '100.00');
    let failedOnce = false;
    const sqs = new Proxy(q.sqs, {
      get(t, p) {
        if (p === 'send') {
          return (cmd: unknown, o?: unknown) => {
            if (cmd instanceof DeleteMessageCommand && !failedOnce) {
              failedOnce = true;
              return Promise.reject(new Error('ECONNRESET during ack'));
            }
            return (t.send as any)(cmd, o);
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as typeof q.sqs;
    const consumer = new SqsConsumer(sqs, h.submit, q.config, h.metrics, logger);
    consumer.start();
    try {
      await q.send(requestedMessage(w, { amount: '25.00' }), w.id);
      await waitFor(async () => failedOnce && (await q.depth(q.mainUrl)).visible + (await q.depth(q.mainUrl)).inFlight === 0, 45_000);
    } finally {
      await consumer.stop();
    }
    expect(await debits(w.id)).toBe(1);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('75.00'));
    await expectLedgerConsistent(h, w.id);
  }, 90_000);

  test('PROCESSO morto depois do commit e antes do ack: outra instância assume sem duplicar', async () => {
    const q = await createTestQueues({ visibilityTimeout: 3 });
    const w = await newWallet(h, '100.00');
    const msg = requestedMessage(w, { amount: '35.00' });
    await q.send(msg, w.id);

    const proc = Bun.spawn(
      ['bun', resolve(import.meta.dir, '../helpers/crash-consumer.ts'), JSON.stringify({ mainUrl: q.mainUrl, dlqUrl: q.dlqUrl, eventsUrl: q.eventsUrl })],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(out).toContain('COMMITTED-BEFORE-ACK');
    expect(code).toBe(137);
    // o commit aconteceu mesmo com o processo morto
    expect((await h.queries.getTransactionByExternalId('provider-a', msg.data.externalTransactionId)).status).toBe('PROCESSED');
    expect(await debits(w.id)).toBe(1);

    // a mensagem continua na fila (sem ack) e uma nova instância a consome como replay
    const survivor = consumerOf(q);
    survivor.start();
    try {
      await waitFor(async () => (await q.depth(q.mainUrl)).visible + (await q.depth(q.mainUrl)).inFlight === 0, 45_000);
    } finally {
      await survivor.stop();
    }
    expect(await debits(w.id)).toBe(1);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('65.00'));
    expect((await q.depth(q.dlqUrl)).visible).toBe(0);
    await expectLedgerConsistent(h, w.id);
  }, 120_000);

  test('shutdown gracioso: conclui o que está em andamento e devolve o resto; nada se perde nem duplica', async () => {
    const q = await createTestQueues({ visibilityTimeout: 3 });
    const wallets = await Promise.all(Array.from({ length: 12 }, () => newWallet(h, '100.00')));
    const msgs = wallets.map((w) => requestedMessage(w, { amount: '10.00' }));
    await Promise.all(msgs.map((m, i) => q.send(m, wallets[i]!.id)));

    const first = consumerOf(q);
    first.start();
    await waitFor(async () => (await countRows(h, `SELECT COUNT(*)::int AS c FROM inbox_messages WHERE message_id = ANY(string_to_array(?, ','))`, [msgs.map((m) => m.messageId).join(',')])) >= 1, 30_000);
    await first.stop(); // SIGTERM simulado: termina o que está em andamento

    const second = consumerOf(q);
    second.start();
    try {
      await waitFor(async () => {
        const { visible, inFlight } = await q.depth(q.mainUrl);
        return visible + inFlight === 0;
      }, 60_000);
    } finally {
      await second.stop();
    }
    for (const w of wallets) {
      expect(await debits(w.id)).toBe(1);
      await expectLedgerConsistent(h, w.id);
    }
    expect((await q.depth(q.dlqUrl)).visible).toBe(0);
  }, 120_000);

  test('REFUND entregue antes da BET pela fila: PENDING_REFERENCE e depois aplicado', async () => {
    const q = await createTestQueues();
    const w = await newWallet(h, '100.00');
    const bet = requestedMessage(w, { amount: '20.00' });
    const refund = requestedMessage(w, { kind: 'REFUND', amount: '20.00', reference: bet.data.externalTransactionId });
    const consumer = consumerOf(q);
    consumer.start();
    try {
      await q.send(refund, w.id); // chega ANTES
      await waitFor(async () => (await h.queries.getTransactionByExternalId('provider-a', refund.data.externalTransactionId).catch(() => null))?.status === 'PENDING_REFERENCE');
      await q.send(bet, w.id);
      await waitFor(async () => (await debits(w.id)) === 1);
      for (let i = 0; i < 30; i++) {
        await h.reprocess.execute();
        if ((await h.queries.getTransactionByExternalId('provider-a', refund.data.externalTransactionId)).status === 'PROCESSED') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await consumer.stop();
    }
    expect((await h.queries.getTransactionByExternalId('provider-a', refund.data.externalTransactionId)).status).toBe('PROCESSED');
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    await expectLedgerConsistent(h, w.id);
  }, 90_000);
});

describe('outbox -> SQS (LocalStack real)', () => {
  test('publisher morre depois do commit e antes de publicar: outra instância publica; duplicata é segura', async () => {
    const q = await createTestQueues();
    const publisher = new SqsEventPublisher(q.sqs, q.eventsUrl);
    // isola esta asserção: marca como publicado tudo que não for desta wallet
    const w = await newWallet(h, '100.00');
    await h.submit.execute({
      idempotencyKey: `k-${uuid()}`, providerId: 'provider-a', externalTransactionId: `e-${uuid()}`,
      playerId: w.playerId, walletId: w.id, roundId: 'r', gameId: 'g', kind: 'BET', money: brl('10.00'),
      correlationId: 'corr-1', source: { type: 'http' },
    });
    await h.orm.em.fork().execute(
      `UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND payload->'data'->>'walletId' <> ?`, [w.id], 'run',
    );

    // (1) commit confirmado, mas "instância 1" morreu: eventos seguem PENDENTES na outbox
    const pending = await countRows(h, `SELECT COUNT(*)::int AS c FROM outbox_messages WHERE published_at IS NULL`);
    expect(pending).toBe(4); // opening: Processed+BalanceChanged; bet: Processed+BalanceChanged
    expect((await q.receiveAll(q.eventsUrl, 500)).length).toBe(0);

    // (2) outra instância assume e publica
    const instance2 = await createHarness({ publisher });
    try {
      expect(await instance2.publishOutbox.execute()).toBe(4);
    } finally {
      await instance2.close();
    }
    const delivered = await q.receiveAll(q.eventsUrl);
    expect(delivered).toHaveLength(4);
    const envelopes = delivered.map((m) => JSON.parse(m.Body!));
    for (const e of envelopes) {
      expect(e).toMatchObject({ version: 1, correlationId: expect.any(String) });
      expect(typeof e.occurredAt).toBe('string');
      expect(typeof e.eventId).toBe('string');
    }
    expect(envelopes.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged',
    ]);
    const balanceChanged = envelopes.find((e) => e.eventType === 'WalletBalanceChanged' && e.data.direction === 'DEBIT');
    expect(balanceChanged.data).toMatchObject({
      walletId: w.id, money: brl('10.00'), balanceBefore: brl('100.00'), balanceAfter: brl('90.00'), walletVersion: 2,
    });

    // (3) publicação duplicada continua segura: mesma dedupId (eventId) => o FIFO descarta
    const row: any[] = await h.orm.em.fork().execute(`SELECT id FROM outbox_messages WHERE payload->'data'->>'walletId' = ? LIMIT 1`, [w.id]);
    const { OutboxMessage } = await import('../../src/domain/outbox-message');
    const replayed = OutboxMessage.rehydrate({
      id: row[0].id, aggregateId: w.id, eventType: 'WalletBalanceChanged', payload: envelopes[0], occurredAt: new Date(),
      attempts: 0,
    });
    await publisher.publish([replayed]);
    await publisher.publish([replayed]);
    expect((await q.receiveAll(q.eventsUrl, 800)).length).toBeLessThanOrEqual(1);
  }, 90_000);

  test('falha de publicação: evento fica pendente com backoff e é publicado quando o SQS volta', async () => {
    const q = await createTestQueues();
    const w = await newWallet(h, '10.00');
    await h.orm.em.fork().execute(
      `UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND payload->'data'->>'walletId' <> ?`, [w.id], 'run',
    );
    const brokenSqs = { send: async () => { throw new Error('sqs unavailable'); } } as any;
    const down = await createHarness({ publisher: new SqsEventPublisher(brokenSqs, q.eventsUrl) });
    try {
      expect(await down.publishOutbox.execute()).toBe(0);
    } finally {
      await down.close();
    }
    expect(await countRows(h, `SELECT COUNT(*)::int AS c FROM outbox_messages WHERE published_at IS NULL AND attempts = 1 AND last_error = 'sqs unavailable'`)).toBe(2);
    await h.orm.em.fork().execute(`UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`, [], 'run');
    const up = await createHarness({ publisher: new SqsEventPublisher(q.sqs, q.eventsUrl) });
    try {
      expect(await up.publishOutbox.execute()).toBe(2);
    } finally {
      await up.close();
    }
    expect((await q.receiveAll(q.eventsUrl)).length).toBe(2);
  }, 60_000);
});
