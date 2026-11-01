import { Inject, Injectable } from '@nestjs/common';
import {
  APP_LOGGER,
  CLOCK,
  EVENT_PUBLISHER,
  METRICS,
  UNIT_OF_WORK,
  type AppLogger,
  type Clock,
  type EventPublisher,
  type Metrics,
  type UnitOfWork,
} from './ports';

/**
 * Publisher da outbox. Vários publishers rodam em paralelo: `lockDue` usa FOR UPDATE SKIP LOCKED,
 * então cada um pega um lote disjunto. Publicação é at-least-once: se o processo morrer entre o envio
 * e o commit, outro publisher reenvia (o SQS FIFO deduplica por eventId e o consumidor é idempotente).
 */
@Injectable()
export class PublishOutbox {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  /** Publica um lote e devolve quantas mensagens foram publicadas com sucesso. */
  async execute(batchSize = 50): Promise<number> {
    const published = await this.uow.run(async (repos) => {
      const now = this.clock.now();
      const batch = await repos.outbox.lockDue(now, batchSize);
      if (batch.length === 0) return 0;

      const outcome = await this.publisher.publish(batch);
      let ok = 0;
      for (const message of batch) {
        const error = outcome.get(message.id);
        if (error === undefined) {
          message.markPublished(this.clock.now());
          ok += 1;
          await repos.outbox.save(message);
        } else {
          message.scheduleRetry(this.clock.now());
          await repos.outbox.save(message, error);
          this.metrics.increment('wager_outbox_publish_failures_total');
          this.metrics.increment('wager_retries_total', { component: 'outbox' });
          this.logger.warn('outbox publish failed', { eventId: message.id, attempts: message.attempts, error });
        }
      }
      return ok;
    });
    if (published > 0) this.metrics.increment('wager_outbox_published_total', {}, published);
    return published;
  }

  /** Atualiza as métricas de lag da outbox (chamado periodicamente). */
  async refreshStats(): Promise<void> {
    await this.uow.run(async (repos) => {
      const stats = await repos.outbox.stats(this.clock.now());
      this.metrics.gauge('wager_outbox_pending', stats.pending);
      this.metrics.gauge('wager_outbox_lag_seconds', stats.oldestLagSeconds);
      this.metrics.gauge('wager_pending_reference', await repos.transactions.countPendingReference());
    });
  }
}
