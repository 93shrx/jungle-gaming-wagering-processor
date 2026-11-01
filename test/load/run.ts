/**
 * `bun run test:load`: sobe N instâncias reais da aplicação (INSTANCES, padrão 3), roda `load.ts` contra elas
 * e as encerra. Requer `docker compose up -d postgres localstack` e as migrations aplicadas.
 * Para apontar para instâncias já existentes: TARGETS=http://host:port,... bun run test/load/load.ts
 */
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const instances = Number(process.env.INSTANCES ?? 3);
const basePort = Number(process.env.BASE_PORT ?? 3301);
const ports = Array.from({ length: instances }, (_, i) => basePort + i);

const procs = ports.map((port) =>
  Bun.spawn(['bun', 'src/main.ts'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
    env: { ...process.env, PORT: String(port), ROLE: 'all', LOG_LEVEL: 'error', DB_POOL_MAX: process.env.DB_POOL_MAX ?? '20' },
  }),
);

const stopAll = () => procs.forEach((p) => p.kill());
process.on('SIGINT', () => (stopAll(), process.exit(130)));

try {
  const deadline = Date.now() + 60_000;
  for (const port of ports) {
    for (;;) {
      try {
        if ((await fetch(`http://localhost:${port}/health/ready`, { signal: AbortSignal.timeout(1500) })).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`instance on :${port} did not become ready`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const load = Bun.spawn(['bun', resolve(import.meta.dir, 'load.ts')], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, TARGETS: ports.map((p) => `http://localhost:${p}`).join(',') },
  });
  process.exitCode = await load.exited;
} finally {
  stopAll();
}
