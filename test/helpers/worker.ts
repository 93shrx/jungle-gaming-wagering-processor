/**
 * Processo-instância usado pelos testes de concorrência multi-processo.
 * Cada processo tem seu próprio pool, seu próprio runtime e NENHUM estado compartilhado em memória.
 * uso: bun worker.ts '<json>'  com { walletId, playerId, count, amount, prefix }
 */
import { brl, cmd, createHarness } from './harness';

const { walletId, playerId, count, amount, prefix } = JSON.parse(process.argv[2]!) as {
  walletId: string;
  playerId: string;
  count: number;
  amount: string;
  prefix: string;
};

const h = await createHarness({ poolMax: 10 });
const wallet = { id: walletId, playerId };
const results: Record<string, number> = {};
const inFlight = new Set<Promise<void>>();

for (let i = 0; i < count; i++) {
  const p = h.submit
    .execute(cmd(wallet, { externalTransactionId: `${prefix}-${i}`, money: brl(amount) }))
    .then((r) => {
      const key = `${r.status}${r.idempotentReplay ? ':replay' : ''}`;
      results[key] = (results[key] ?? 0) + 1;
    })
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
  if (inFlight.size >= 8) await Promise.race(inFlight);
}
await Promise.all(inFlight);
await h.close();
console.log(JSON.stringify(results));
