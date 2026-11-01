import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError, IdempotencyConflictError, TransientInfrastructureError, WalletNotFoundError } from '../../application/errors';
import type { AppLogger, Metrics } from '../../application/ports';
import type { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { DomainError, InvalidMoneyError, InvalidTransactionError } from '../../domain/errors';
import type { AppConfig } from '../../config';

export type Disposition = 'ack' | 'retry' | 'dead-letter';

export interface Classified {
  disposition: Disposition;
  reason: string;
}

/**
 * Classificação dos erros do consumidor:
 *  - NEGÓCIO  (terminal, ack):  o efeito/rejeição já foi persistido ou não há o que persistir (ex.: wallet inexistente).
 *  - PERMANENTE (DLQ):          a mensagem nunca vai ser válida (payload malformado, valor/kind inválido).
 *  - TRANSITÓRIO (retry):       infraestrutura (DB/SQS) — devolve a mensagem com backoff até o limite, depois DLQ.
 */
export function classifyError(e: unknown): Classified {
  if (e instanceof WalletNotFoundError) return { disposition: 'ack', reason: 'WALLET_NOT_FOUND' };
  if (e instanceof IdempotencyConflictError) return { disposition: 'ack', reason: 'IDEMPOTENCY_CONFLICT' };
  if (e instanceof InvalidMoneyError || e instanceof InvalidTransactionError || e instanceof MalformedMessageError) {
    return { disposition: 'dead-letter', reason: (e as Error).message };
  }
  if (e instanceof TransientInfrastructureError) return { disposition: 'retry', reason: e.message };
  if (e instanceof DomainError || e instanceof ApplicationError) return { disposition: 'dead-letter', reason: e.message };
  return { disposition: 'retry', reason: e instanceof Error ? e.message : String(e) };
}

export class MalformedMessageError extends Error {}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new MalformedMessageError(`field "${field}" must be a non-empty string`);
  return v;
};

/** Valida o envelope e devolve o comando para o MESMO caso de uso da entrada HTTP. */
export function parseMessage(body: string | undefined, consumerName: string) {
  let json: any;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new MalformedMessageError('body is not valid JSON');
  }
  if (!json || typeof json !== 'object') throw new MalformedMessageError('body must be an object');
  const messageId = str(json.messageId, 'messageId');
  if (json.type !== 'WagerTransactionRequested') throw new MalformedMessageError(`unsupported type: ${String(json.type)}`);
  const d = json.data;
  if (!d || typeof d !== 'object') throw new MalformedMessageError('data must be an object');
  const money = d.money;
  if (!money || typeof money !== 'object') throw new MalformedMessageError('data.money must be an object');
  return {
    idempotencyKey: str(d.idempotencyKey, 'data.idempotencyKey'),
    providerId: str(d.providerId, 'data.providerId'),
    externalTransactionId: str(d.externalTransactionId, 'data.externalTransactionId'),
    playerId: str(d.playerId, 'data.playerId'),
    walletId: str(d.walletId, 'data.walletId'),
    roundId: str(d.roundId, 'data.roundId'),
    gameId: str(d.gameId, 'data.gameId'),
    kind: str(d.kind, 'data.kind'),
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId:
      d.referenceExternalTransactionId === undefined || d.referenceExternalTransactionId === null
        ? undefined
        : str(d.referenceExternalTransactionId, 'data.referenceExternalTransactionId'),
    correlationId: typeof json.correlationId === 'string' ? json.correlationId : messageId,
    source: { type: 'sqs' as const, messageId, consumerName },
  };
}

/** UUID de wallet inválido vira "wallet inexistente" (negócio) em vez de erro de driver. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Consumidor SQS FIFO.
 *  - `ack` (DeleteMessage) SOMENTE depois do commit (o use case só retorna após o COMMIT).
 *  - Mensagens de grupos diferentes em paralelo; dentro do mesmo grupo (walletId), em ordem.
 *  - Shutdown: para de receber, aborta o long poll, conclui o que está em andamento e devolve
 *    a visibilidade do que foi recebido mas ainda não começou.
 */
export class SqsConsumer {
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly cfg: AppConfig,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.poll();
  }

  /** Conclui as mensagens em andamento (até `graceMs`) e encerra o polling. */
  async stop(graceMs = this.cfg.shutdownGraceMs): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await Promise.race([
      Promise.all([this.loop, ...this.inFlight]).catch(() => undefined),
      new Promise((r) => setTimeout(r, graceMs)),
    ]);
  }

  private async poll(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      let messages: Message[] = [];
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.cfg.queues.transactionsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.cfg.consumer.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = res.Messages ?? [];
      } catch (e) {
        if (!this.running) break;
        this.logger.warn('sqs receive failed', { error: e instanceof Error ? e.message : String(e) });
        this.metrics.increment('wager_sqs_messages_total', { outcome: 'receive_error' });
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (messages.length === 0) continue;

      const groups = new Map<string, Message[]>();
      for (const m of messages) {
        const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'none';
        (groups.get(g) ?? groups.set(g, []).get(g)!).push(m);
      }
      const work = [...groups.values()].map((batch) => this.processGroup(batch));
      const p = Promise.all(work).then(() => undefined);
      this.inFlight.add(p);
      try {
        await p;
      } finally {
        this.inFlight.delete(p);
      }
    }
  }

  private async processGroup(batch: Message[]): Promise<void> {
    for (let i = 0; i < batch.length; i++) {
      if (!this.running) {
        // Shutdown: devolve imediatamente o que ainda não começou.
        await Promise.all(batch.slice(i).map((m) => this.release(m)));
        return;
      }
      let ok = false;
      try {
        ok = await this.handle(batch[i]!);
      } catch (e) {
        // ex.: SQS indisponível ao enviar à DLQ/ack. A mensagem NÃO é perdida: volta para a fila e o loop segue vivo.
        this.logger.error('sqs message handling failed', { messageId: batch[i]!.MessageId, error: e instanceof Error ? e.message : String(e) });
        await this.release(batch[i]!);
      }
      if (!ok) {
        // Mantém a ordem do grupo: se uma mensagem voltou para retry, as seguintes também voltam.
        await Promise.all(batch.slice(i + 1).map((m) => this.release(m)));
        return;
      }
    }
  }

  /** @returns false quando a mensagem foi devolvida para retry (o resto do grupo deve esperar) */
  private async handle(message: Message): Promise<boolean> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let messageId = message.MessageId ?? 'unknown';
    try {
      const command = parseMessage(message.Body, this.cfg.consumer.name);
      messageId = command.source.messageId;
      if (!UUID_RE.test(command.walletId)) throw new WalletNotFoundError(command.walletId);

      const result = await this.submit.execute(command);
      await this.ack(message); // ack SOMENTE depois do commit
      this.metrics.increment('wager_sqs_messages_total', { outcome: result.idempotentReplay ? 'duplicate' : 'processed' });
      this.logger.info('sqs message processed', {
        messageId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        correlationId: command.correlationId,
        status: result.status,
        replay: result.idempotentReplay,
      });
      return true;
    } catch (e) {
      const { disposition, reason } = classifyError(e);
      if (disposition === 'ack') {
        await this.ack(message);
        this.metrics.increment('wager_sqs_messages_total', { outcome: 'business_error' });
        this.logger.warn('sqs message acked after business error', { messageId, reason });
        return true;
      }
      if (disposition === 'dead-letter' || receiveCount >= this.cfg.consumer.maxReceiveCount) {
        await this.deadLetter(message, reason);
        return true;
      }
      await this.retryLater(message, receiveCount, reason);
      return false;
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.cfg.queues.transactionsUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  /** Devolve a mensagem à fila agora (visibilidade 0), sem contar como falha. */
  private async release(message: Message): Promise<void> {
    await this.sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: this.cfg.queues.transactionsUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }))
      .catch(() => undefined);
  }

  private async retryLater(message: Message, receiveCount: number, reason: string): Promise<void> {
    const { visibilityBaseSeconds: base, visibilityCapSeconds: cap } = this.cfg.consumer;
    const timeout = Math.min(base * 2 ** (receiveCount - 1), cap);
    await this.sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: this.cfg.queues.transactionsUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: timeout }))
      .catch(() => undefined);
    this.metrics.increment('wager_retries_total', { component: 'sqs_consumer' });
    this.metrics.increment('wager_sqs_messages_total', { outcome: 'retry' });
    this.logger.warn('sqs message scheduled for retry', { messageId: message.MessageId, receiveCount, visibilityTimeout: timeout, reason });
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    // Envia à DLQ ANTES de apagar da fila principal: se a DLQ falhar, a mensagem não se perde (volta por retry).
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.cfg.queues.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: message.MessageId ?? `${Date.now()}`,
        MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason.slice(0, 250) } },
      }),
    );
    await this.ack(message);
    this.metrics.increment('wager_dlq_messages_total');
    this.metrics.increment('wager_sqs_messages_total', { outcome: 'dead_letter' });
    this.logger.error('sqs message moved to DLQ', { messageId: message.MessageId, reason });
  }
}
