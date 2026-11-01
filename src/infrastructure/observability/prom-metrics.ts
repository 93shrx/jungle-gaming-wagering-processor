import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricName, Metrics } from '../../application/ports';

type Def =
  | { type: 'counter'; help: string; labels?: string[] }
  | { type: 'gauge'; help: string }
  | { type: 'histogram'; help: string; labels?: string[]; buckets?: number[] };

const DEFINITIONS: Record<MetricName, Def> = {
  wager_transactions_total: { type: 'counter', help: 'Transações por status final/intermediário', labels: ['status', 'kind'] },
  wager_duplicates_total: { type: 'counter', help: 'Duplicatas detectadas (replays idempotentes)', labels: ['source'] },
  wager_idempotency_conflicts_total: { type: 'counter', help: 'Mesma chave com payload diferente' },
  wager_retries_total: { type: 'counter', help: 'Retries por componente', labels: ['component'] },
  wager_dlq_messages_total: { type: 'counter', help: 'Mensagens enviadas à DLQ' },
  wager_lock_conflicts_total: { type: 'counter', help: 'Conflitos de lock/serialização (deadlock etc.)', labels: ['sqlstate'] },
  wager_reconciliation_divergences_total: { type: 'counter', help: 'Divergências saldo x ledger' },
  wager_outbox_published_total: { type: 'counter', help: 'Eventos publicados' },
  wager_outbox_publish_failures_total: { type: 'counter', help: 'Falhas de publicação da outbox' },
  wager_processing_duration_seconds: {
    type: 'histogram',
    help: 'Latência de processamento de transações',
    labels: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  },
  wager_outbox_lag_seconds: { type: 'gauge', help: 'Idade do evento pendente mais antigo da outbox' },
  wager_outbox_pending: { type: 'gauge', help: 'Eventos pendentes na outbox' },
  wager_pending_reference: { type: 'gauge', help: 'Transações aguardando referência' },
  wager_sqs_messages_total: { type: 'counter', help: 'Mensagens SQS por resultado', labels: ['outcome'] },
};

/** Labels não declaradas são descartadas (prom-client lança em label desconhecida). */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly instruments = new Map<MetricName, Counter | Gauge | Histogram>();
  private readonly labelNames = new Map<MetricName, string[]>();

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
    for (const [name, def] of Object.entries(DEFINITIONS) as [MetricName, Def][]) {
      const labelNames = ('labels' in def && def.labels) || [];
      this.labelNames.set(name, labelNames);
      const base = { name, help: def.help, labelNames, registers: [this.registry] };
      if (def.type === 'counter') this.instruments.set(name, new Counter(base));
      else if (def.type === 'gauge') this.instruments.set(name, new Gauge({ name, help: def.help, registers: [this.registry] }));
      else this.instruments.set(name, new Histogram({ ...base, buckets: def.buckets }));
    }
  }

  increment(name: MetricName, labels: Record<string, string> = {}, value = 1): void {
    (this.instruments.get(name) as Counter).inc(this.pick(name, labels), value);
  }

  observe(name: MetricName, value: number, labels: Record<string, string> = {}): void {
    (this.instruments.get(name) as Histogram).observe(this.pick(name, labels), value);
  }

  gauge(name: MetricName, value: number): void {
    (this.instruments.get(name) as Gauge).set(value);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  private pick(name: MetricName, labels: Record<string, string>): Record<string, string> {
    const allowed = this.labelNames.get(name) ?? [];
    return Object.fromEntries(Object.entries(labels).filter(([k]) => allowed.includes(k)));
  }
}
