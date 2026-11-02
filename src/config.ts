export type Role = 'http' | 'consumer' | 'workers';

export interface AppConfig {
  port: number;
  roles: Set<Role>;
  databaseUrl: string;
  aws: { region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string };
  queues: { transactionsUrl: string; dlqUrl: string; eventsUrl: string };
  consumer: {
    name: string;
    maxReceiveCount: number;
    waitTimeSeconds: number;
    visibilityBaseSeconds: number;
    visibilityCapSeconds: number;
  };
  outbox: { batchSize: number; intervalMs: number };
  pendingReference: { maxAttempts: number; ttlMs: number; baseBackoffMs: number; capBackoffMs: number; batchSize: number; intervalMs: number };
  shutdownGraceMs: number;
}

const int = (name: string, fallback: number) => {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Invalid numeric env ${name}=${raw}`);
  return v;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawRole = (env.ROLE ?? 'all').toLowerCase();
  const roles = new Set<Role>(
    rawRole === 'all' ? ['http', 'consumer', 'workers'] : (rawRole.split(',').map((r) => r.trim()) as Role[]),
  );
  const base = env.AWS_ENDPOINT ?? 'http://localhost:4566';
  return {
    port: int('PORT', 3000),
    roles,
    databaseUrl: env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
    aws: {
      region: env.AWS_REGION ?? 'us-east-1',
      endpoint: env.AWS_ENDPOINT ?? 'http://localhost:4566',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    queues: {
      transactionsUrl: env.SQS_QUEUE_URL ?? `${base}/000000000000/wager-transactions.fifo`,
      dlqUrl: env.SQS_DLQ_URL ?? `${base}/000000000000/wager-transactions-dlq.fifo`,
      eventsUrl: env.EVENTS_QUEUE_URL ?? `${base}/000000000000/wager-events.fifo`,
    },
    consumer: {
      name: 'wager-transactions-consumer',
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 2),
      visibilityBaseSeconds: int('SQS_VISIBILITY_BASE_SECONDS', 2),
      visibilityCapSeconds: int('SQS_VISIBILITY_CAP_SECONDS', 60),
    },
    outbox: { batchSize: int('OUTBOX_BATCH_SIZE', 50), intervalMs: int('OUTBOX_INTERVAL_MS', 500) },
    pendingReference: {
      maxAttempts: int('PENDING_REF_MAX_ATTEMPTS', 10),
      ttlMs: int('PENDING_REF_TTL_MS', 10 * 60_000),
      baseBackoffMs: int('PENDING_REF_BASE_BACKOFF_MS', 1_000),
      capBackoffMs: int('PENDING_REF_CAP_BACKOFF_MS', 60_000),
      batchSize: int('PENDING_REF_BATCH_SIZE', 50),
      intervalMs: int('PENDING_REF_INTERVAL_MS', 1_000),
    },
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 25_000),
  };
}
