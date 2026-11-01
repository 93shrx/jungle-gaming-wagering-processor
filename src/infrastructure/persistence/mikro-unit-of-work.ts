import type { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import type { Metrics, Repositories, UnitOfWork } from '../../application/ports';
import { DomainError } from '../../domain/errors';
import { SqlRepositories } from './sql-repositories';

/** SQLSTATEs em que repetir a transação inteira é seguro. */
const LOCK_CONFLICT_CODES = new Set(['40001', '40P01', '55P03']);
const TRANSIENT_CODE_PREFIXES = ['08', '53', '57', '58'];
const TRANSIENT_MESSAGE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|timeout|too many clients|the database system is/i;

const MAX_LOCK_RETRIES = 3;

function sqlState(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = err?.code ?? err?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => work(new SqlRepositories(em as SqlEntityManager)));
      } catch (e) {
        const code = sqlState(e);
        if (code && LOCK_CONFLICT_CODES.has(code)) {
          this.metrics.increment('wager_lock_conflicts_total', { sqlstate: code });
          if (attempt < MAX_LOCK_RETRIES) {
            this.metrics.increment('wager_retries_total', { component: 'transaction' });
            await new Promise((r) => setTimeout(r, 5 * 2 ** attempt + Math.random() * 10));
            continue;
          }
        }
        throw this.translate(e, code);
      }
    }
  }

  private translate(e: unknown, code: string | undefined): unknown {
    if (e instanceof DomainError || e instanceof ApplicationError) return e;
    const message = e instanceof Error ? e.message : String(e);
    if (
      (code && (LOCK_CONFLICT_CODES.has(code) || TRANSIENT_CODE_PREFIXES.some((p) => code.startsWith(p)))) ||
      TRANSIENT_MESSAGE.test(message)
    ) {
      return new TransientInfrastructureError(message, e);
    }
    return e;
  }
}
