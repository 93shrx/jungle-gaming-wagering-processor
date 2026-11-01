/**
 * Teste de carga (closed-loop) contra instâncias já em execução.
 *
 *   TARGETS=http://localhost:3301,http://localhost:3302,http://localhost:3303 \
 *   DURATION_S=30 CONCURRENCY=48 WALLETS=100 DUPLICATE_RATE=0.05 bun run test:load
 *
 * Mede: throughput, p50/p95/p99, taxa de erro, conflitos de concorrência (counter das instâncias) e outbox lag.
 * Ao final reconcilia TODAS as wallets via API: o teste só "passa" se wallet == ledger em todas.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { v7 as uuid } from 'uuid';

const targets = (process.env.TARGETS ?? 'http://localhost:3000').split(',').map((t) => t.trim());
const durationS = Number(process.env.DURATION_S ?? 30);
const concurrency = Number(process.env.CONCURRENCY ?? 32);
const walletCount = Number(process.env.WALLETS ?? 50);
const duplicateRate = Number(process.env.DUPLICATE_RATE ?? 0.05);
const hotShare = Number(process.env.HOT_SHARE ?? 0.2); // fração do tráfego que cai numa única wallet quente

const jsonHeaders = { 'content-type': 'application/json' };
let rr = 0;
const nextTarget = () => targets[rr++ % targets.length]!;
const j = async (r: Response): Promise<any> => r.json();

const wallets: { id: string; playerId: string }[] = [];
for (let i = 0; i < walletCount; i++) {
  const res = await fetch(`${nextTarget()}/wallets`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ playerId: `load-${uuid()}`, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status}`);
  const w = await j(res);
  wallets.push({ id: w.id, playerId: w.playerId });
}

const latencies: number[] = [];
const statusCount = new Map<string, number>();
let errors = 0;
let replays = 0;
const stopAt = Date.now() + durationS * 1000;
const hot = wallets[0]!;

async function worker() {
  while (Date.now() < stopAt) {
    const w = Math.random() < hotShare ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
    const ext = `ld-${uuid()}`;
    const kind = Math.random() < 0.8 ? 'BET' : Math.random() < 0.5 ? 'WIN' : 'LOSS';
    const body = JSON.stringify({
      providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.id, roundId: `r-${ext}`,
      gameId: 'g', kind, money: { amount: '1.00', currency: 'BRL' },
    });
    const send = async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${nextTarget()}/wagering/transactions`, {
          method: 'POST', headers: { ...jsonHeaders, 'idempotency-key': `load:${ext}` }, body,
        });
        const out = await j(res);
        latencies.push(performance.now() - t0);
        if (out.idempotentReplay) replays++;
        const key = `${res.status}`;
        statusCount.set(key, (statusCount.get(key) ?? 0) + 1);
        if (res.status >= 500) errors++;
      } catch {
        latencies.push(performance.now() - t0);
        errors++;
      }
    };
    await send();
    if (Math.random() < duplicateRate) await send(); // retry do provedor
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedS = (performance.now() - started) / 1000;

// métricas das instâncias
const scrape = async (target: string) => (await fetch(`${target}/metrics`)).text();
const sumMetric = (texts: string[], name: string) =>
  texts.reduce((acc, t) => acc + [...t.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+-]+)$`, 'gm'))].reduce((s, m) => s + Number(m[1]), 0), 0);
const maxMetric = (texts: string[], name: string) =>
  Math.max(0, ...texts.map((t) => Number(new RegExp(`^${name} ([0-9.e+-]+)$`, 'm').exec(t)?.[1] ?? 0)));
let texts = await Promise.all(targets.map(scrape));
const lockConflicts = sumMetric(texts, 'wager_lock_conflicts_total');
const peakLagDuring = maxMetric(texts, 'wager_outbox_lag_seconds');

// drena a outbox e mede o tempo até lag ~ 0
const drainStart = performance.now();
let drained = false;
for (let i = 0; i < 120; i++) {
  texts = await Promise.all(targets.map(scrape));
  if (maxMetric(texts, 'wager_outbox_pending') === 0) { drained = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
const drainSeconds = (performance.now() - drainStart) / 1000;

// invariante final: wallet == ledger em TODAS as wallets
let inconsistent = 0;
for (const w of wallets) {
  const r = await j(await fetch(`${nextTarget()}/wallets/${w.id}/reconciliation`, { method: 'POST' }));
  if (!r.consistent) inconsistent++;
}

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const report = {
  environment: {
    os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30), runtime: `bun ${Bun.version}`,
    topology: `${targets.length} instance(s) of the app; PostgreSQL 16 + LocalStack in Docker (local)`,
  },
  methodology: { durationS, concurrency, wallets: walletCount, hotWalletShare: hotShare, duplicateRate, mix: '80% BET / 10% WIN / 10% LOSS, 1.00 BRL each', loop: 'closed-loop' },
  results: {
    requests: latencies.length,
    replaysDetected: replays,
    throughputRps: Number((latencies.length / elapsedS).toFixed(1)),
    latencyMs: { p50: Number(pct(50).toFixed(1)), p95: Number(pct(95).toFixed(1)), p99: Number(pct(99).toFixed(1)), max: Number((latencies.at(-1) ?? 0).toFixed(1)) },
    statusCodes: Object.fromEntries(statusCount),
    errorRate: Number((errors / Math.max(1, latencies.length)).toFixed(4)),
    lockConflicts,
    outbox: { peakLagSecondsDuringRun: peakLagDuring, secondsToDrainAfterRun: Number(drainSeconds.toFixed(1)), drained },
    walletsInconsistent: inconsistent,
  },
};
console.log(JSON.stringify(report, null, 2));
const dir = resolve(import.meta.dir, 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'latest.json'), JSON.stringify(report, null, 2));
if (inconsistent > 0 || errors > 0) process.exit(1);
