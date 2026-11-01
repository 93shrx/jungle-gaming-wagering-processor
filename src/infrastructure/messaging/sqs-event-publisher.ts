import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica os eventos da outbox em SQS FIFO.
 * - MessageGroupId = aggregateId  (ordem por agregado: OTIMIZAÇÃO, não garantia)
 * - MessageDeduplicationId = eventId (deduplicação do broker: OTIMIZAÇÃO; o consumidor deve ser idempotente)
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<Map<string, string | undefined>> {
    const outcome = new Map<string, string | undefined>();
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const res = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m) => ({
              Id: m.id,
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
            })),
          }),
        );
        for (const m of chunk) outcome.set(m.id, undefined);
        for (const f of res.Failed ?? []) outcome.set(f.Id!, `${f.Code}: ${f.Message ?? ''}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        for (const m of chunk) outcome.set(m.id, reason);
      }
    }
    return outcome;
  }
}
