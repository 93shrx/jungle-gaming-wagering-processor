import type { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { HealthProbes } from '../application/ports';

/** Readiness: PostgreSQL e SQS alcançáveis (com timeout curto para não pendurar o probe). */
export class InfraHealthProbes implements HealthProbes {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async database(): Promise<void> {
    await withTimeout(this.orm.em.fork().execute('SELECT 1'), 2_000, 'postgres');
  }

  async queue(): Promise<void> {
    await withTimeout(
      this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] })),
      2_000,
      'sqs',
    );
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
