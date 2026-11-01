import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuid } from 'uuid';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '../../src/application/errors';
import { InvalidMoneyError, InvalidTransactionError } from '../../src/domain/errors';
import { brl, cmd, countRows, createHarness, expectLedgerConsistent, newWallet, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const ledgerCount = (walletId: string) =>
  countRows(h, `SELECT COUNT(*)::int AS c FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]);
const eventTypes = async (walletId: string) => {
  const rows: any[] = await h.orm.em.fork().execute(
    `SELECT o.event_type FROM outbox_messages o
      WHERE o.payload->'data'->>'walletId' = ? ORDER BY o.occurred_at, o.id`,
    [walletId],
  );
  return rows.map((r) => r.event_type as string);
};

describe('criação de wallet', () => {
  test('saldo inicial gera OPENING + CREDIT na mesma transação; version = 1', async () => {
    const w = await newWallet(h, '1000.00');
    expect(w.version).toBe(1);
    expect(w.balance).toEqual(brl('1000.00'));
    expect(await ledgerCount(w.id)).toBe(1);
    const rows: any[] = await h.orm.em.fork().execute(
      `SELECT kind, status FROM wager_transactions WHERE wallet_id = ?`,
      [w.id],
    );
    expect(rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED' }]);
    await expectLedgerConsistent(h, w.id);
  });

  test('saldo zero não gera lançamento', async () => {
    const w = await newWallet(h, '0.00');
    expect(await ledgerCount(w.id)).toBe(0);
    await expectLedgerConsistent(h, w.id);
  });

  test('wallet duplicada para o mesmo player+moeda => conflito', async () => {
    const playerId = `p-${uuid()}`;
    await h.createWallet.execute({ playerId, initialBalance: brl('1.00'), correlationId: 'c' });
    await expect(
      h.createWallet.execute({ playerId, initialBalance: brl('5.00'), correlationId: 'c' }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });

  test('saldo inicial inválido é rejeitado', async () => {
    await expect(
      h.createWallet.execute({ playerId: 'x', initialBalance: { amount: '-1.00', currency: 'BRL' }, correlationId: 'c' }),
    ).rejects.toThrow(InvalidMoneyError);
  });
});

describe('BET / WIN / LOSS', () => {
  test('BET debita, gera 1 lançamento DEBIT e eventos', async () => {
    const w = await newWallet(h, '1000.00');
    const r = await h.submit.execute(cmd(w, { money: brl('25.00') }));
    expect(r).toMatchObject({ status: 'PROCESSED', balance: brl('975.00'), idempotentReplay: false, failureCode: null });
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('975.00'));
    expect((await h.queries.getWallet(w.id)).version).toBe(2);
    expect(await ledgerCount(w.id)).toBe(2);
    expect((await eventTypes(w.id)).sort()).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged', // opening
      'WagerTransactionProcessed', 'WalletBalanceChanged', // bet
    ].sort());
    await expectLedgerConsistent(h, w.id);
  });

  test('replay devolve o resultado ORIGINAL (saldo observado naquele momento)', async () => {
    const w = await newWallet(h, '100.00');
    const first = cmd(w, { money: brl('30.00') });
    const r1 = await h.submit.execute(first);
    await h.submit.execute(cmd(w, { money: brl('20.00') })); // saldo atual agora é 50.00
    const replay = await h.submit.execute(first);
    expect(replay).toMatchObject({ transactionId: r1.transactionId, status: 'PROCESSED', idempotentReplay: true });
    expect(replay.balance).toEqual(brl('70.00'));
    expect(await ledgerCount(w.id)).toBe(3); // opening + 2 bets, replay não duplicou
  });

  test('mesma key com payload diferente => conflito (não é replay)', async () => {
    const w = await newWallet(h);
    const first = cmd(w, { money: brl('10.00') });
    await h.submit.execute(first);
    await expect(h.submit.execute({ ...first, money: brl('11.00') })).rejects.toThrow(IdempotencyConflictError);
    await expect(
      h.submit.execute({ ...first, idempotencyKey: 'another-key', money: brl('11.00') }),
    ).rejects.toThrow(IdempotencyConflictError); // mesmo (provider, external), outro hash
    await expectLedgerConsistent(h, w.id);
  });

  test('saldo insuficiente => REJECTED persistido, sem ledger, replay devolve REJECTED', async () => {
    const w = await newWallet(h, '10.00');
    const c = cmd(w, { money: brl('10.01') });
    const r = await h.submit.execute(c);
    expect(r).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('10.00') });
    expect(await ledgerCount(w.id)).toBe(1);
    expect((await h.queries.getWallet(w.id)).version).toBe(1);
    const replay = await h.submit.execute(c);
    expect(replay).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
    const view = await h.queries.getTransaction(r.transactionId);
    expect(view.status).toBe('REJECTED');
    expect(await eventTypes(w.id)).toContain('WagerTransactionRejected');
    await expectLedgerConsistent(h, w.id);
  });

  test('WIN credita; LOSS não move saldo, não gera ledger nem WalletBalanceChanged', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, { money: brl('40.00') });
    await h.submit.execute(bet);
    const win = await h.submit.execute(
      cmd(w, { kind: 'WIN', money: brl('90.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win).toMatchObject({ status: 'PROCESSED', balance: brl('150.00') });
    const before = await ledgerCount(w.id);
    const loss = await h.submit.execute(cmd(w, { kind: 'LOSS', money: brl('5.00') }));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: brl('150.00') });
    expect(await ledgerCount(w.id)).toBe(before);
    const lossEvents: any[] = await h.orm.em.fork().execute(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`,
      [loss.transactionId],
    );
    expect(lossEvents.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
    await expectLedgerConsistent(h, w.id);
  });

  test('validações de contrato', async () => {
    const w = await newWallet(h);
    await expect(h.submit.execute(cmd(w, { kind: 'OPENING' }))).rejects.toThrow(InvalidTransactionError);
    await expect(h.submit.execute(cmd(w, { providerId: '__system__' }))).rejects.toThrow(InvalidTransactionError);
    await expect(h.submit.execute(cmd(w, { kind: 'REFUND' }))).rejects.toThrow(InvalidTransactionError);
    await expect(h.submit.execute(cmd(w, { money: { amount: '1.001', currency: 'BRL' } }))).rejects.toThrow(
      InvalidMoneyError,
    );
    await expect(h.submit.execute(cmd({ id: uuid(), playerId: 'x' }))).rejects.toThrow(WalletNotFoundError);
  });

  test('moeda divergente e player divergente => REJECTED auditável', async () => {
    const w = await newWallet(h);
    const usd = await h.submit.execute(cmd(w, { money: { amount: '1.00', currency: 'USD' } }));
    expect(usd).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
    const other = await h.submit.execute(cmd({ id: w.id, playerId: 'someone-else' }));
    expect(other).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_MISMATCH' });
    await expectLedgerConsistent(h, w.id);
  });
});

describe('REFUND / ROLLBACK', () => {
  async function betOf(w: { id: string; playerId: string }, amount = '25.00', over = {}) {
    const c = cmd(w, { money: brl(amount), ...over });
    const r = await h.submit.execute(c);
    return { c, r };
  }

  test('REFUND reverte a BET uma única vez (inclusive via ROLLBACK)', async () => {
    const w = await newWallet(h, '100.00');
    const { c: bet } = await betOf(w);
    const refund = await h.submit.execute(
      cmd(w, { kind: 'REFUND', money: brl('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });

    const again = await h.submit.execute(
      cmd(w, { kind: 'REFUND', money: brl('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(again).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    const rollback = await h.submit.execute(
      cmd(w, { kind: 'ROLLBACK', money: brl('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    await expectLedgerConsistent(h, w.id);
  });

  test('ROLLBACK de BET devolve (CREDIT); ROLLBACK de WIN retira (DEBIT)', async () => {
    const w = await newWallet(h, '100.00');
    const { c: bet } = await betOf(w, '40.00');
    const rbBet = await h.submit.execute(
      cmd(w, { kind: 'ROLLBACK', money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rbBet).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });

    const { c: bet2 } = await betOf(w, '10.00');
    const win = cmd(w, { kind: 'WIN', money: brl('30.00'), referenceExternalTransactionId: bet2.externalTransactionId });
    await h.submit.execute(win);
    const rbWin = await h.submit.execute(
      cmd(w, { kind: 'ROLLBACK', money: brl('30.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rbWin).toMatchObject({ status: 'PROCESSED', balance: brl('90.00') });
    const dirs: any[] = await h.orm.em.fork().execute(
      `SELECT direction FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [rbWin.transactionId],
    );
    expect(dirs).toEqual([{ direction: 'DEBIT' }]);
    await expectLedgerConsistent(h, w.id);
  });

  test('reversão que deixaria saldo negativo => REVERSAL_WOULD_OVERDRAW (distinto de INSUFFICIENT_FUNDS)', async () => {
    const w = await newWallet(h, '10.00');
    const bet = cmd(w, { money: brl('10.00') });
    await h.submit.execute(bet); // saldo 0
    const win = cmd(w, { kind: 'WIN', money: brl('50.00'), referenceExternalTransactionId: bet.externalTransactionId });
    await h.submit.execute(win); // saldo 50
    await h.submit.execute(cmd(w, { money: brl('50.00') })); // saldo 0 de novo
    const rb = await h.submit.execute(
      cmd(w, { kind: 'ROLLBACK', money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rb).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: brl('0.00') });
    await expectLedgerConsistent(h, w.id);
  });

  test('regras de referência: valor, rodada, kind, referência rejeitada', async () => {
    const w = await newWallet(h, '100.00');
    const { c: bet } = await betOf(w, '20.00');
    const refOf = (kind: string, over = {}) =>
      cmd(w, { kind, money: brl('20.00'), referenceExternalTransactionId: bet.externalTransactionId, ...over });

    expect(await h.submit.execute(refOf('REFUND', { money: brl('19.00') }))).toMatchObject({
      status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH',
    });
    expect(await h.submit.execute(refOf('REFUND', { roundId: 'other-round' }))).toMatchObject({
      status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH',
    });
    // REFUND de uma WIN não é permitido
    const win = cmd(w, { kind: 'WIN', money: brl('5.00'), referenceExternalTransactionId: bet.externalTransactionId });
    await h.submit.execute(win);
    expect(
      await h.submit.execute(cmd(w, { kind: 'REFUND', money: brl('5.00'), referenceExternalTransactionId: win.externalTransactionId })),
    ).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
    // referência rejeitada
    const failedBet = cmd(w, { money: brl('9999.00') });
    await h.submit.execute(failedBet);
    expect(
      await h.submit.execute(
        cmd(w, { kind: 'REFUND', money: brl('9999.00'), referenceExternalTransactionId: failedBet.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
    await expectLedgerConsistent(h, w.id);
  });

  test('referência de outro provider não é resolvida (mesmo externalId)', async () => {
    const w = await newWallet(h, '100.00');
    const { c: bet } = await betOf(w, '20.00');
    const r = await h.submit.execute(
      cmd(w, {
        providerId: 'provider-b', kind: 'REFUND', money: brl('20.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(r.status as string).toBe('PENDING_REFERENCE'); // escopo por (providerId, referenceExternalId)
  });
});

describe('referências fora de ordem', () => {
  test('REFUND antes da BET => PENDING_REFERENCE; após a BET, o worker aplica', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, { money: brl('25.00') });
    const refund = cmd(w, { kind: 'REFUND', money: brl('25.00'), referenceExternalTransactionId: bet.externalTransactionId });

    const early = await h.submit.execute(refund);
    expect(early).toMatchObject({ status: 'PENDING_REFERENCE', balance: null, idempotentReplay: false });
    expect(await h.submit.execute(refund)).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: true });
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    expect(await eventTypes(w.id)).toContain('WagerTransactionPendingReference');

    await h.submit.execute(bet); // a BET chega depois e acorda a dependente
    await h.reprocess.execute();
    const view = await h.queries.getTransaction(early.transactionId);
    expect(view.status).toBe('PROCESSED');
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    expect(await ledgerCount(w.id)).toBe(3); // opening + bet + refund
    await expectLedgerConsistent(h, w.id);
  });

  test('referência que nunca chega => REJECTED REFERENCE_NOT_FOUND após o limite, com evento', async () => {
    const hh = await createHarness({ policy: { maxAttempts: 2, baseBackoffMs: 5, capBackoffMs: 10 } });
    try {
      const w = await newWallet(hh, '50.00');
      const r = await hh.submit.execute(
        cmd(w, { kind: 'ROLLBACK', money: brl('1.00'), referenceExternalTransactionId: 'never-arrives' }),
      );
      expect(r.status as string).toBe('PENDING_REFERENCE');
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 15));
        await hh.reprocess.execute();
        if ((await hh.queries.getTransaction(r.transactionId)).status === 'REJECTED') break;
      }
      const view = await hh.queries.getTransaction(r.transactionId);
      expect(view).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
      const events: any[] = await hh.orm.em.fork().execute(
        `SELECT event_type, payload->'data'->>'failureCode' AS code FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id`,
        [r.transactionId],
      );
      expect(events.map((e) => e.event_type).sort()).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
      expect(events.find((e) => e.event_type === 'WagerTransactionRejected').code).toBe('REFERENCE_NOT_FOUND');
      await expectLedgerConsistent(hh, w.id);
    } finally {
      await hh.close();
    }
  });
});

describe('atomicidade e inbox', () => {
  test('falha no meio da transação desfaz TUDO (ledger, saldo, outbox, transação)', async () => {
    const w = await newWallet(h, '100.00');
    const c = cmd(w, { money: brl('10.00') });
    await expect(
      h.uow.run(async (repos) => {
        // reproduz o que o caso de uso faria e falha antes do commit
        const wallet = (await repos.wallets.findByIdForUpdate(w.id))!;
        const v = wallet.version;
        const tx = (await import('../../src/domain/wager-transaction')).WagerTransaction.create({
          id: uuid(), providerId: c.providerId, externalTransactionId: c.externalTransactionId,
          idempotencyKey: c.idempotencyKey, payloadHash: 'h', walletId: w.id, playerId: w.playerId, roundId: 'r',
          gameId: 'g', kind: (await import('../../src/domain/wager-transaction')).WagerTransactionKind.Bet,
          money: (await import('../../src/domain/money')).Money.from(brl('10.00')), createdAt: new Date(),
        });
        await repos.transactions.insertIfAbsent(tx);
        const entry = wallet.debit({ money: tx.money, transactionId: tx.id, entryId: uuid(), at: new Date() });
        await repos.ledger.append(entry);
        await repos.wallets.save(wallet, v);
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('100.00'));
    expect(await ledgerCount(w.id)).toBe(1);
    await expect(h.queries.getTransactionByExternalId(c.providerId, c.externalTransactionId)).rejects.toThrow();
    await expectLedgerConsistent(h, w.id);
  });

  test('inbox: redelivery da mesma mensagem não duplica efeito; messageId novo com mesma key é replay', async () => {
    const w = await newWallet(h, '100.00');
    const base = cmd(w, { money: brl('30.00'), source: { type: 'sqs', messageId: 'msg-1', consumerName: 'wager-consumer' } });
    const r1 = await h.submit.execute(base);
    const r2 = await h.submit.execute(base);
    expect(r1.status as string).toBe('PROCESSED');
    expect(r2).toMatchObject({ transactionId: r1.transactionId, idempotentReplay: true });
    const r3 = await h.submit.execute({ ...base, source: { type: 'sqs', messageId: 'msg-2', consumerName: 'wager-consumer' } });
    expect(r3).toMatchObject({ transactionId: r1.transactionId, idempotentReplay: true });
    expect((await h.queries.getWallet(w.id)).balance).toEqual(brl('70.00'));
    const inbox: any[] = await h.orm.em.fork().execute(
      `SELECT message_id, processed_at IS NOT NULL AS done FROM inbox_messages WHERE message_id IN ('msg-1')`,
    );
    expect(inbox).toEqual([{ message_id: 'msg-1', done: true }]);
    await expectLedgerConsistent(h, w.id);
  });
});

describe('outbox', () => {
  test('publisher marca como publicado; falha agenda retry com backoff', async () => {
    let fail = true;
    const hh = await createHarness({
      publisher: { publish: async (msgs) => new Map(msgs.map((m) => [m.id, fail ? 'sqs down' : undefined])) },
    });
    try {
      const w = await newWallet(hh, '10.00');
      const mine = async () =>
        (await hh.orm.em.fork().execute(
          `SELECT attempts, published_at IS NOT NULL AS published, last_error FROM outbox_messages WHERE payload->'data'->>'walletId' = ?`,
          [w.id],
        )) as any[];
      // limpa tudo o que outros testes deixaram pendente para isolar a asserção
      await hh.orm.em.fork().execute(`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL AND payload->'data'->>'walletId' <> ?`, [w.id], 'run');
      await hh.publishOutbox.execute();
      expect((await mine()).every((m) => m.attempts === 1 && !m.published && m.last_error === 'sqs down')).toBe(true);
      fail = false;
      await hh.orm.em.fork().execute(`UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`, [], 'run');
      await hh.publishOutbox.execute();
      expect((await mine()).every((m) => m.published)).toBe(true);
    } finally {
      await hh.close();
    }
  });
});
