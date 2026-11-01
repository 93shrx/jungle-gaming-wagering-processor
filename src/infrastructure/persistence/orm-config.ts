import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20260101000001_initial_schema } from './migrations/Migration20260101000001_initial_schema';

export const DEFAULT_DATABASE_URL = 'postgres://wager:wager@localhost:5433/wager';

/**
 * MikroORM é usado para: pool de conexões, `em.transactional()` (fronteira da transação SQL)
 * e migrations versionadas/reversíveis. Os comandos críticos de concorrência
 * (FOR UPDATE, ON CONFLICT, SKIP LOCKED) são SQL explícito, para o comportamento ser auditável.
 */
export function buildOrmConfig(overrides: { clientUrl?: string; poolMax?: number } = {}) {
  return defineConfig({
    clientUrl: overrides.clientUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 1, max: overrides.poolMax ?? Number(process.env.DB_POOL_MAX ?? 20) },
    extensions: [Migrator],
    migrations: {
      transactional: true,
      migrationsList: [
        { name: 'Migration20260101000001_initial_schema', class: Migration20260101000001_initial_schema },
      ],
    },
    allowGlobalContext: true,
    // `balance` etc. chegam como string (NUMERIC), nunca como number.
  });
}
