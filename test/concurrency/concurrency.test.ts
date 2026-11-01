import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuid } from 'uuid';
import { resolve } from 'node:path';
import { brl, cmd, countRows, createHarness, expectLedgerConsistent, newWallet, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ poolMax: 40 });
});
afterAll(async () => {
  await h.close();
});

const ledgerRows = (walletId: string, direction?: string) =>
  countRows(
    h,
    `SELECT COUNT(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = ? ${direction ? `AND direction = '${direction}'` : ''}`,
    [walletId],
  );
const txCount = (walletId: string, status: string, kind = 'BET') =>
  countRows(h, `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE wallet_id = ? AND status = ? AND kind = ?`, [
    walletId, status, kind,
  ]);

describe('concorrência (paralelismo real contra PostgreSQL)', () => {
  test('1. a mesma aposta enviada 50 vezes em paralelo => um único débito', async () => {
    const w = await newWallet(h, '100.00');
    const c = cmd(w, { money: brl('10.00') });
    const results = await Promise.all(Array.from({ length: 50 }, () => h.submit.execute({ ...c })));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '90.00')).toBe(true);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('90.00'));
    expect(await ledgerRows(w.id, 'DEBIT')).toBe(1);
    await expectLedgerConsistent(h, w.id);
  });

  test('2. cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    for (let round = 0; round < 10; round++) {
      const w = await newWallet(h, '100.00');
      const [a, b] = await Promise.all([
        h.submit.execute(cmd(w, { money: brl('80.00') })),
        h.submit.execute(cmd(w, { money: brl('80.00') })),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses as string[]).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = a.status === 'REJECTED' ? a : b;
      expect(rejected.failureCode as string | null).toBe('INSUFFICIENT_FUNDS');
      expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('20.00'));
      expect(await ledgerRows(w.id, 'DEBIT')).toBe(1);

      // retry de ambas: nenhum retry duplica o débito
      await Promise.all([...Array(5)].map(() => h.submit.execute(cmd(w, { money: brl('80.00') }))));
      expect(await ledgerRows(w.id, 'DEBIT')).toBe(1);
      await expectLedgerConsistent(h, w.id);
    }
  });

  test('hot wallet: 200 apostas de 1.00 em paralelo sobre saldo 100 => exatamente 100 processadas', async () => {
    const w = await newWallet(h, '100.00');
    const results = await Promise.all(Array.from({ length: 200 }, () => h.submit.execute(cmd(w, { money: brl('1.00') }))));
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(100);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(100);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('0.00'));
    expect(await ledgerRows(w.id, 'DEBIT')).toBe(100);
    expect((await h.queries.getWallet(w.id)).version).toBe(101);
    await expectLedgerConsistent(h, w.id);
  });

  test('3. wallets distintas em paralelo', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => newWallet(h, '50.00')));
    const started = Date.now();
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => h.submit.execute(cmd(w, { money: brl('10.00') })))),
    );
    for (const w of wallets) {
      expect(await txCount(w.id, 'PROCESSED')).toBe(5);
      expect(await txCount(w.id, 'REJECTED')).toBe(5);
      expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('0.00'));
      await expectLedgerConsistent(h, w.id);
    }
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test('mix concorrente BET/WIN/LOSS/REFUND na mesma wallet mantém wallet == ledger', async () => {
    const w = await newWallet(h, '500.00');
    const bets = Array.from({ length: 30 }, () => cmd(w, { money: brl('5.00') }));
    await Promise.all(bets.map((b) => h.submit.execute(b)));
    await Promise.all([
      ...bets.slice(0, 10).map((b) =>
        h.submit.execute(cmd(w, { kind: 'REFUND', money: brl('5.00'), referenceExternalTransactionId: b.externalTransactionId })),
      ),
      ...bets.slice(10, 20).map((b) =>
        h.submit.execute(cmd(w, { kind: 'WIN', money: brl('12.00'), referenceExternalTransactionId: b.externalTransactionId })),
      ),
      ...bets.slice(20).map(() => h.submit.execute(cmd(w, { kind: 'LOSS', money: brl('5.00') }))),
      ...Array.from({ length: 20 }, () => h.submit.execute(cmd(w, { money: brl('7.00') }))),
    ]);
    // 500 - 150 (30 bets) + 50 (10 refunds) + 120 (10 wins) - 140 (20 bets) = 380
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('380.00'));
    await expectLedgerConsistent(h, w.id);
  });

  test('reversões concorrentes da mesma BET: exatamente uma é aplicada', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, { money: brl('25.00') });
    await h.submit.execute(bet);
    const kinds = ['REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK'];
    const results = await Promise.all(
      kinds.map((kind) =>
        h.submit.execute(cmd(w, { kind, money: brl('25.00'), referenceExternalTransactionId: bet.externalTransactionId })),
      ),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(7);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    await expectLedgerConsistent(h, w.id);
  });

  test('7. REFUND/ROLLBACK entregues ANTES da referência, em paralelo com ela', async () => {
    const w = await newWallet(h, '100.00');
    const pairs = Array.from({ length: 10 }, () => {
      const bet = cmd(w, { money: brl('10.00') });
      return {
        bet,
        reversal: cmd(w, {
          kind: Math.random() < 0.5 ? 'REFUND' : 'ROLLBACK',
          money: brl('10.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      };
    });
    await Promise.all(pairs.map((p) => h.submit.execute(p.reversal))); // reversões primeiro
    await Promise.all(pairs.map((p) => h.submit.execute(p.bet)));
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await Promise.all([h.reprocess.execute(), h.reprocess.execute()]); // dois workers concorrentes
      if ((await countRows(h, `SELECT COUNT(*)::int AS c FROM wager_transactions WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'`, [w.id])) === 0) break;
    }
    expect(await txCount(w.id, 'PENDING_REFERENCE', 'REFUND')).toBe(0);
    expect(await txCount(w.id, 'PENDING_REFERENCE', 'ROLLBACK')).toBe(0);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    expect(await ledgerRows(w.id, 'DEBIT')).toBe(10);
    expect(await ledgerRows(w.id, 'CREDIT')).toBe(11); // opening + 10 reversões
    await expectLedgerConsistent(h, w.id);
  });

  test('6. dois publishers sobre a mesma outbox nunca publicam o mesmo evento duas vezes', async () => {
    const seen = new Map<string, number>();
    const mk = async () =>
      createHarness({
        publisher: {
          publish: async (msgs) => {
            await new Promise((r) => setTimeout(r, 25)); // simula latência de rede
            for (const m of msgs) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
            return new Map(msgs.map((m) => [m.id, undefined]));
          },
        },
      });
    const [p1, p2] = await Promise.all([mk(), mk()]);
    try {
      const w = await newWallet(h, '1000.00');
      await Promise.all(Array.from({ length: 40 }, () => h.submit.execute(cmd(w, { money: brl('1.00') }))));
      await h.orm.em.fork().execute(
        `UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND payload->'data'->>'walletId' <> ?`,
        [w.id], 'run',
      );
      const drain = async (p: Harness) => {
        let total = 0;
        for (;;) {
          const n = await p.publishOutbox.execute(7);
          if (n === 0) return total;
          total += n;
        }
      };
      const [a, b] = await Promise.all([drain(p1), drain(p2)]);
      expect(a + b).toBe(2 + 80 + 0 /* opening: 2; 40 bets: 2 eventos cada */);
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
      expect(seen.size).toBe(82);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(0);
      expect(await countRows(h, `SELECT COUNT(*)::int AS c FROM outbox_messages WHERE published_at IS NULL`)).toBe(0);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });
});

describe('4. múltiplas instâncias (processos Bun separados)', () => {
  const run = async (args: object) => {
    const proc = Bun.spawn(['bun', resolve(import.meta.dir, '../helpers/worker.ts'), JSON.stringify(args)], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`worker failed (${code}): ${err}`);
    return JSON.parse(out.trim().split('\n').pop()!) as Record<string, number>;
  };

  test('4 processos disputam o mesmo saldo, com as MESMAS apostas reenviadas por todos', async () => {
    const w = await newWallet(h, '100.00');
    const shared = `shared-${uuid()}`;
    // cada processo envia as 150 mesmas apostas de 1.00 (mesmos externalIds) => 4x de duplicatas entre instâncias
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () => run({ walletId: w.id, playerId: w.playerId, count: 150, amount: '1.00', prefix: shared })),
    );
    const total = (key: string) => outputs.reduce((s, o) => s + (o[key] ?? 0), 0);
    expect(await txCount(w.id, 'PROCESSED')).toBe(100);
    expect(await txCount(w.id, 'REJECTED')).toBe(50);
    expect(await ledgerRows(w.id, 'DEBIT')).toBe(100);
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('0.00'));
    // 600 requisições => só 150 efeitos distintos: o resto foi idempotência persistente entre processos
    expect(total('PROCESSED') + total('REJECTED')).toBe(150);
    await expectLedgerConsistent(h, w.id);
  }, 120_000);

  test('3 processos em wallets distintas e em uma wallet quente ao mesmo tempo', async () => {
    const hot = await newWallet(h, '60.00');
    const others = await Promise.all(Array.from({ length: 3 }, () => newWallet(h, '30.00')));
    await Promise.all([
      run({ walletId: hot.id, playerId: hot.playerId, count: 40, amount: '2.00', prefix: `a-${uuid()}` }),
      run({ walletId: hot.id, playerId: hot.playerId, count: 40, amount: '2.00', prefix: `b-${uuid()}` }),
      run({ walletId: hot.id, playerId: hot.playerId, count: 40, amount: '2.00', prefix: `c-${uuid()}` }),
      ...others.map((o, i) => run({ walletId: o.id, playerId: o.playerId, count: 20, amount: '3.00', prefix: `o${i}-${uuid()}` })),
    ]);
    expect(await txCount(hot.id, 'PROCESSED')).toBe(30);
    expect((await h.queries.getWallet(hot.id)).balance).toEqual(brl('0.00'));
    await expectLedgerConsistent(h, hot.id);
    for (const o of others) {
      expect(await txCount(o.id, 'PROCESSED')).toBe(10);
      await expectLedgerConsistent(h, o.id);
    }
  }, 120_000);
});
