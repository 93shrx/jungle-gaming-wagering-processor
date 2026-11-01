import { Inject, Injectable } from '@nestjs/common';
import { InvalidTransactionError } from '../domain/errors';
import type { FailureCode } from '../domain/failure-codes';
import { InboxMessage } from '../domain/inbox-message';
import { Money, type MoneyProps } from '../domain/money';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { IdempotencyConflictError, WalletNotFoundError } from './errors';
import {
  CLOCK,
  ID_GENERATOR,
  METRICS,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type Metrics,
  type Repositories,
  type UnitOfWork,
} from './ports';
import { WagerTransactionProcessor } from './wager-transaction-processor';

export const SYSTEM_PROVIDER_ID = '__system__';

export type SubmitSource = { type: 'http' } | { type: 'sqs'; messageId: string; consumerName: string };

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  source: SubmitSource;
}

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

/**
 * Caso de uso ÚNICO de submissão, compartilhado por HTTP e SQS.
 *
 * Idempotência: quem decide é o banco. UNIQUE(idempotency_key) e UNIQUE(provider, external id)
 * + INSERT … ON CONFLICT DO NOTHING; o lock da wallet serializa as operações concorrentes.
 */
@Injectable()
export class SubmitWagerTransaction {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    private readonly processor: WagerTransactionProcessor,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand): Promise<TransactionResult> {
    const started = performance.now();
    const kind = this.parseKind(cmd.kind);
    if (cmd.providerId === SYSTEM_PROVIDER_ID) throw new InvalidTransactionError('providerId is reserved');
    const money = Money.from(cmd.money);
    const payloadHash = computePayloadHash({ ...cmd, kind, money: money.toJSON() });

    const result = await this.uow.run((repos) => this.process(repos, cmd, kind, money, payloadHash));

    this.metrics.observe('wager_processing_duration_seconds', (performance.now() - started) / 1000, {
      source: cmd.source.type,
    });
    return result;
  }

  private async process(
    repos: Repositories,
    cmd: SubmitWagerTransactionCommand,
    kind: WagerTransactionKind,
    money: Money,
    payloadHash: string,
  ): Promise<TransactionResult> {
    const now = this.clock.now();

    if (cmd.source.type === 'sqs') {
      const first = await repos.inbox.tryReceive(
        InboxMessage.receive({
          messageId: cmd.source.messageId,
          consumerName: cmd.source.consumerName,
          payloadHash,
          receivedAt: now,
        }),
      );
      if (!first) {
        // Redelivery: o efeito já foi confirmado junto com o inbox; devolve o resultado original.
        const done = await this.findExisting(repos, cmd);
        if (done) return this.replay(done, payloadHash, cmd);
      }
    }

    // Caminho rápido do replay: sem lock.
    const early = await this.findExisting(repos, cmd);
    if (early) return this.replay(early, payloadHash, cmd);

    // Unidade de concorrência: a wallet. Tudo abaixo roda com a linha travada.
    const wallet = await repos.wallets.findByIdForUpdate(cmd.walletId);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    const afterLock = await this.findExisting(repos, cmd);
    if (afterLock) return this.replay(afterLock, payloadHash, cmd);

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });

    if (!(await repos.transactions.insertIfAbsent(tx))) {
      const raced = await this.findExisting(repos, cmd);
      if (!raced) throw new Error('insertIfAbsent lost the race but no row is visible');
      return this.replay(raced, payloadHash, cmd);
    }

    await this.processor.apply(repos, wallet, tx, {
      now,
      correlationId: cmd.correlationId,
      causationId: cmd.source.type === 'sqs' ? cmd.source.messageId : cmd.idempotencyKey,
    });

    if (cmd.source.type === 'sqs') {
      await repos.inbox.markProcessed(cmd.source.consumerName, cmd.source.messageId, now);
    }
    return this.toResult(tx, false);
  }

  private async findExisting(repos: Repositories, cmd: SubmitWagerTransactionCommand) {
    return repos.transactions.findExisting(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
  }

  private replay(existing: WagerTransaction, payloadHash: string, cmd: SubmitWagerTransactionCommand): TransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      this.metrics.increment('wager_idempotency_conflicts_total');
      throw new IdempotencyConflictError(cmd.idempotencyKey);
    }
    this.metrics.increment('wager_duplicates_total', { source: cmd.source.type });
    return this.toResult(existing, true);
  }

  private toResult(tx: WagerTransaction, idempotentReplay: boolean): TransactionResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.observedBalance?.toJSON() ?? null,
      failureCode: tx.failureCode ?? null,
      idempotentReplay,
    };
  }

  private parseKind(raw: string): WagerTransactionKind {
    const kind = Object.values(WagerTransactionKind).find((k) => k === raw);
    if (!kind || kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError(`Unsupported transaction kind: ${String(raw)}`);
    }
    return kind;
  }
}
