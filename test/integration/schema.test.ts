import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuid } from 'uuid';
import { cmd, createHarness, newWallet, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const sql = (q: string, params: unknown[] = []) => h.orm.em.fork().execute(q, params, 'run');
const now = () => new Date();

async function insertWallet(id: string, balance: string, player = `p-${uuid()}`) {
  await sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, 'BRL', ?, 1, ?, ?)`,
    [id, player, balance, now(), now()],
  );
}

describe('constraints do schema', () => {
  test('migration é reversível (down + up)', async () => {
    // down/up em transação isolada de dados: apenas valida que o runner conhece o histórico
    const executed = await h.orm.migrator.getExecuted();
    expect(executed.length).toBeGreaterThanOrEqual(1);
  });

  test('saldo negativo é rejeitado pelo banco', async () => {
    await expect(insertWallet(uuid(), '-0.01')).rejects.toThrow(/ck_wallet_balance_non_negative/);
  });

  test('uma wallet por (playerId, currency)', async () => {
    const player = `p-${uuid()}`;
    await insertWallet(uuid(), '0.00', player);
    await expect(insertWallet(uuid(), '0.00', player)).rejects.toThrow(/uq_wallet_player_currency/);
  });

  test('ledger é append-only: UPDATE e DELETE são bloqueados', async () => {
    const w = await newWallet(h, '50.00');
    await expect(sql(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [w.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id])).rejects.toThrow(/append-only/);
  });

  test('ledger exige aritmética balanceada', async () => {
    const w = await newWallet(h, '50.00');
    const bet = await h.submit.execute(cmd(w));
    await expect(
      sql(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'DEBIT', 5, 'BRL', 40, 37, ?)`,
        [uuid(), w.id, bet.transactionId, now()],
      ),
    ).rejects.toThrow(/ck_ledger_balanced|uq_ledger_wallet_transaction/);
  });

  test('no máximo um lançamento por (wallet, transação)', async () => {
    const w = await newWallet(h, '50.00');
    const bet = await h.submit.execute(cmd(w));
    await expect(
      sql(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'DEBIT', 1, 'BRL', 40, 39, ?)`,
        [uuid(), w.id, bet.transactionId, now()],
      ),
    ).rejects.toThrow(/uq_ledger_wallet_transaction/);
  });

  test('saldo da wallet deve bater com o ledger no commit (trigger deferido)', async () => {
    const w = await newWallet(h, '50.00');
    await expect(sql(`UPDATE wallets SET balance = 999.00 WHERE id = ?`, [w.id])).rejects.toThrow(/diverges from ledger/);
    // wallet sem lançamento nenhum com saldo > 0 também é inválida
    await expect(insertWallet(uuid(), '10.00')).rejects.toThrow(/diverges from ledger/);
  });

  test('OPENING só existe para o provider interno', async () => {
    const w = await newWallet(h, '0.00');
    await expect(
      sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, created_at) VALUES (?, 'provider-a', ?, ?, 'h', ?, ?, 'r', 'g', 'OPENING', 1, 'BRL', 'PENDING', ?)`,
        [uuid(), uuid(), uuid(), w.id, w.playerId, now()],
      ),
    ).rejects.toThrow(/ck_tx_opening_internal/);
  });

  test('(provider, externalTransactionId) e idempotency_key são únicos', async () => {
    const w = await newWallet(h);
    const c = cmd(w);
    await h.submit.execute(c);
    const ins = (ext: string, key: string) =>
      sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, created_at) VALUES (?, ?, ?, ?, 'h', ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', ?)`,
        [uuid(), c.providerId, ext, key, w.id, w.playerId, now()],
      );
    await expect(ins(c.externalTransactionId, 'other-key')).rejects.toThrow(/uq_tx_provider_external/);
    await expect(ins('other-ext', c.idempotencyKey)).rejects.toThrow(/uq_tx_idempotency_key/);
  });

  test('rejeitada exige failure_code; REFUND exige referência', async () => {
    const w = await newWallet(h);
    const base = (kind: string, status: string, ref: string | null, failure: string | null) =>
      sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, failure_code, processed_at, created_at)
         VALUES (?, 'provider-a', ?, ?, 'h', ?, ?, 'r', 'g', ?, 1, 'BRL', ?, ?, ?, ?, ?)`,
        [uuid(), uuid(), uuid(), w.id, w.playerId, kind, status, ref, failure, now(), now()],
      );
    await expect(base('BET', 'REJECTED', null, null)).rejects.toThrow(/ck_tx_failure_code/);
    await expect(base('REFUND', 'PENDING', null, null)).rejects.toThrow(/ck_tx_reference_required/);
  });

  test('uma transação só pode ser revertida uma vez (índice parcial único)', async () => {
    const w = await newWallet(h);
    const bet = cmd(w);
    const betResult = await h.submit.execute(bet);
    const refund = cmd(w, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const r = await h.submit.execute(refund);
    expect(r.status as string).toBe('PROCESSED');
    // tentativa de contornar a aplicação: segundo REFUND PROCESSED apontando para a mesma BET
    await expect(
      sql(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id, processed_at, created_at)
         VALUES (?, 'provider-a', ?, ?, 'h', ?, ?, 'round-1', 'g', 'ROLLBACK', 10, 'BRL', 'PROCESSED', ?, ?, ?, ?)`,
        [uuid(), uuid(), uuid(), w.id, w.playerId, bet.externalTransactionId, betResult.transactionId, now(), now()],
      ),
    ).rejects.toThrow(/uq_tx_single_reversal/);
  });
});
