import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { v7 as uuid } from 'uuid';
import { loadConfig, type AppConfig } from '../../src/config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';

export const ENDPOINT = process.env.AWS_ENDPOINT ?? 'http://localhost:4566';

export interface TestQueues {
  sqs: SQSClient;
  config: AppConfig;
  mainUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  send(body: unknown, groupId: string, dedupId?: string): Promise<void>;
  receiveAll(queueUrl: string, quietMs?: number): Promise<Message[]>;
  depth(queueUrl: string): Promise<{ visible: number; inFlight: number }>;
}

/** Filas FIFO exclusivas por teste (com DLQ + redrive), para não haver interferência entre testes/execuções. */
export async function createTestQueues(
  opts: { maxReceiveCount?: number; visibilityTimeout?: number; consumer?: Partial<AppConfig['consumer']> } = {},
): Promise<TestQueues> {
  const base = loadConfig({ ...process.env, AWS_ENDPOINT: ENDPOINT });
  const sqs = createSqsClient(base.aws);
  const id = uuid().slice(-12);
  const names = { main: `t-${id}.fifo`, dlq: `t-${id}-dlq.fifo`, events: `t-${id}-events.fifo` };
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: fifo }));
  await sqs.send(
    new CreateQueueCommand({
      QueueName: names.main,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(opts.visibilityTimeout ?? 2),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: `arn:aws:sqs:us-east-1:000000000000:${names.dlq}`,
          maxReceiveCount: String(opts.maxReceiveCount ?? 5),
        }),
      },
    }),
  );
  await sqs.send(new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }));
  const url = (n: string) => `${ENDPOINT}/000000000000/${n}`;
  const config: AppConfig = {
    ...base,
    queues: { transactionsUrl: url(names.main), dlqUrl: url(names.dlq), eventsUrl: url(names.events) },
    consumer: {
      ...base.consumer,
      maxReceiveCount: opts.maxReceiveCount ?? 5,
      waitTimeSeconds: 1,
      visibilityBaseSeconds: 1,
      visibilityCapSeconds: 2,
      ...opts.consumer,
    },
    shutdownGraceMs: 10_000,
  };
  return {
    sqs,
    config,
    mainUrl: config.queues.transactionsUrl,
    dlqUrl: config.queues.dlqUrl,
    eventsUrl: config.queues.eventsUrl,
    async send(body, groupId, dedupId) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: config.queues.transactionsUrl,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          MessageDeduplicationId: dedupId ?? uuid(),
        }),
      );
    },
    async receiveAll(queueUrl, quietMs = 1500) {
      const out: Message[] = [];
      const deadline = Date.now() + 15_000;
      let lastGot = Date.now();
      while (Date.now() < deadline && Date.now() - lastGot < quietMs) {
        const res = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30, MessageAttributeNames: ['All'] }),
        );
        for (const m of res.Messages ?? []) {
          out.push(m);
          lastGot = Date.now();
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
        }
      }
      return out;
    },
    async depth(queueUrl) {
      const r = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return {
        visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      };
    },
  };
}

export function requestedMessage(
  wallet: { id: string; playerId: string },
  over: { messageId?: string; externalTransactionId?: string; kind?: string; amount?: string; reference?: string } = {},
) {
  const externalTransactionId = over.externalTransactionId ?? `tx-${uuid()}`;
  return {
    messageId: over.messageId ?? `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: over.kind ?? 'BET',
      money: { amount: over.amount ?? '10.00', currency: 'BRL' },
      ...(over.reference ? { referenceExternalTransactionId: over.reference } : {}),
    },
  };
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 20_000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
