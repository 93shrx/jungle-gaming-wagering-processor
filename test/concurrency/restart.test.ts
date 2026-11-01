import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { v7 as uuid } from 'uuid';
import { brl, countRows, createHarness, expectLedgerConsistent, newWallet, type Harness } from '../helpers/harness';
import { createTestQueues, requestedMessage, waitFor } from '../helpers/sqs';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ poolMax: 10 });
});
afterAll(async () => {
  await h.close();
});

const ROOT = resolve(import.meta.dir, '../..');

/** Instâncias REAIS da aplicação (bun src/main.ts) em processos separados. */
function startInstance(port: number, env: Record<string, string>) {
  return Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, ...env, PORT: String(port), ROLE: 'all', OUTBOX_INTERVAL_MS: '200', PENDING_REF_INTERVAL_MS: '300', LOG_LEVEL: 'error' },
  });
}

async function waitReady(port: number) {
  await waitFor(async () => {
    try {
      return (await fetch(`http://localhost:${port}/health/ready`, { signal: AbortSignal.timeout(1500) })).status === 200;
    } catch {
      return false;
    }
  }, 40_000, 300);
}

describe('8. reinício do serviço com ≥ 3 instâncias reais', () => {
  test('kill -9 de uma instância no meio da carga + reinício: consistência final comprovada', async () => {
    const q = await createTestQueues({ visibilityTimeout: 3 });
    const env = {
      SQS_QUEUE_URL: q.mainUrl,
      SQS_DLQ_URL: q.dlqUrl,
      EVENTS_QUEUE_URL: q.eventsUrl,
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_VISIBILITY_BASE_SECONDS: '1',
    };
    const ports = [3201, 3202, 3203];
    const procs = ports.map((p) => startInstance(p, env));
    try {
      await Promise.all(ports.map(waitReady));

      const w = await newWallet(h, '300.00');
      const HTTP_N = 240;
      const SQS_N = 120;

      // 120 mensagens na fila (consumidas pelas 3 instâncias)
      const sqsMsgs = Array.from({ length: SQS_N }, (_, i) => requestedMessage(w, { amount: '1.00', externalTransactionId: `s-${uuid()}-${i}` }));
      await Promise.all(sqsMsgs.map((m) => q.send(m, w.id)));

      const runId = uuid();
      let alive = [...ports];
      const submit = async (i: number, attempt = 0): Promise<void> => {
        const port = alive[(i + attempt) % alive.length]!;
        const ext = `h-${runId}-${i}`;
        try {
          const res = await fetch(`http://localhost:${port}/wagering/transactions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${ext}` },
            body: JSON.stringify({
              providerId: 'provider-a', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
              roundId: 'round-1', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
            }),
            signal: AbortSignal.timeout(20_000),
          });
          if (res.status === 503 || res.status >= 500) throw new Error(`retryable ${res.status}`);
          expect([200, 422]).toContain(res.status);
        } catch (e) {
          if (attempt >= 8) throw e;
          await new Promise((r) => setTimeout(r, 200));
          return submit(i, attempt + 1); // MESMA Idempotency-Key em outra instância
        }
      };

      let killedAt = -1;
      const inFlight = new Set<Promise<void>>();
      for (let i = 0; i < HTTP_N; i++) {
        const p = submit(i).finally(() => inFlight.delete(p));
        inFlight.add(p);
        // envio duplicado em paralelo para outra instância (retry do provedor)
        const dup = submit(i, 1).finally(() => inFlight.delete(dup));
        inFlight.add(dup);
        if (inFlight.size >= 20) await Promise.race(inFlight);
        if (i === Math.floor(HTTP_N * 0.4) && killedAt < 0) {
          killedAt = i;
          procs[0]!.kill(9); // morte súbita da instância 0, com requisições e mensagens SQS em andamento
          alive = ports.slice(1);
          setTimeout(() => {
            procs[0] = startInstance(ports[0]!, env); // reinício
          }, 1_500);
        }
      }
      await Promise.all(inFlight);
      expect(killedAt).toBeGreaterThan(0);
      alive = [...ports];
      await waitReady(ports[0]!);

      // todas as mensagens SQS confirmadas e a outbox esvaziada
      await waitFor(async () => (await q.depth(q.mainUrl)).visible + (await q.depth(q.mainUrl)).inFlight === 0, 90_000, 500);
      await waitFor(
        async () => (await countRows(h, `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [w.id])) === HTTP_N + SQS_N,
        60_000, 500,
      );
      await waitFor(
        async () => (await countRows(h, `SELECT COUNT(*)::int AS c FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = ?`, [w.id])) === 0
          && (await countRows(h, `SELECT COUNT(*)::int AS c FROM outbox_messages WHERE aggregate_id IN (SELECT id::text FROM wager_transactions WHERE wallet_id = ?) AND published_at IS NULL`, [w.id])) === 0,
        60_000, 500,
      );

      const processed = await countRows(h, `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`, [w.id]);
      const rejected = await countRows(h, `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'REJECTED'`, [w.id]);
      expect(processed).toBe(300); // saldo 300.00 / apostas de 1.00
      expect(rejected).toBe(HTTP_N + SQS_N - 300);
      expect(await countRows(h, `SELECT COUNT(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.id])).toBe(300);
      expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('0.00'));
      expect((await q.depth(q.dlqUrl)).visible).toBe(0);
      await expectLedgerConsistent(h, w.id);

      // eventos efetivamente chegaram ao broker, pelas instâncias que sobreviveram/reiniciaram
      expect((await q.depth(q.eventsUrl)).visible).toBeGreaterThan(0);
    } finally {
      for (const p of procs) p.kill();
    }
  }, 300_000);
});
