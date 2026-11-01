import { Inject, Injectable } from '@nestjs/common';
import { exponentialBackoffMs } from '../domain/backoff';
import { BusinessRuleViolation, InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-codes';
import {
  EventContext,
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/integration-events';
import { LedgerDirection } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/outbox-message';
import { validateReference } from '../domain/reference-rules';
import type { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import {
  ID_GENERATOR,
  METRICS,
  PENDING_REFERENCE_POLICY,
  type IdGenerator,
  type Metrics,
  type PendingReferencePolicy,
  type Repositories,
} from './ports';

export interface ProcessingContext {
  now: Date;
  correlationId: string;
  causationId?: string;
}

type ReferenceLookup = { state: 'none' } | { state: 'wait' } | { state: 'ready'; ref: WagerTransaction };

/**
 * Regras de BET/WIN/LOSS/REFUND/ROLLBACK aplicadas sobre uma transação já persistida
 * (PENDING ou PENDING_REFERENCE) e a wallet JÁ TRAVADA (FOR UPDATE) pelo chamador.
 *
 * Nunca lança por regra de negócio: a rejeição é persistida (e confirmada) com seu failureCode.
 * Erros de infraestrutura propagam e desfazem a transação SQL inteira.
 */
@Injectable()
export class WagerTransactionProcessor {
  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY) private readonly policy: PendingReferencePolicy,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async apply(repos: Repositories, wallet: Wallet, tx: WagerTransaction, ctx: ProcessingContext): Promise<void> {
    try {
      this.assertPreconditions(wallet, tx);
      const lookup = await this.resolveReference(repos, tx);
      if (lookup.state !== 'ready' && tx.referenceExternalTransactionId) {
        await this.awaitReference(repos, wallet, tx, ctx);
        return;
      }
      await this.applyMovement(repos, wallet, tx, lookup.state === 'ready' ? lookup.ref : undefined, ctx);
    } catch (e) {
      if (e instanceof BusinessRuleViolation) {
        await this.reject(repos, wallet, tx, e.failureCode, ctx);
        return;
      }
      throw e;
    }
  }

  private assertPreconditions(wallet: Wallet, tx: WagerTransaction): void {
    if (tx.playerId !== wallet.playerId) throw new BusinessRuleViolation(FailureCode.PlayerMismatch);
    if (tx.money.currency !== wallet.currency) throw new BusinessRuleViolation(FailureCode.CurrencyMismatch);
  }

  private async resolveReference(repos: Repositories, tx: WagerTransaction): Promise<ReferenceLookup> {
    if (!tx.referenceExternalTransactionId) return { state: 'none' };
    const ref = await repos.transactions.findByProviderExternal(tx.providerId, tx.referenceExternalTransactionId);
    if (!ref) return { state: 'wait' };
    if (validateReference(tx, ref) === 'WAIT') return { state: 'wait' };
    if (tx.requiresReference() && (await repos.transactions.findProcessedReversalOf(ref.id))) {
      throw new BusinessRuleViolation(FailureCode.AlreadyReversed);
    }
    return { state: 'ready', ref };
  }

  private async applyMovement(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    ref: WagerTransaction | undefined,
    ctx: ProcessingContext,
  ): Promise<void> {
    const expectedVersion = wallet.version;
    const events: IntegrationEvent<unknown>[] = [];

    if (!tx.affectsBalance()) {
      tx.markProcessed(ref?.id, ctx.now, wallet.balance);
      await repos.transactions.save(tx);
      events.push(WagerTransactionProcessed.from(tx, this.eventCtx(ctx)));
    } else {
      const movement = { money: tx.money, transactionId: tx.id, entryId: this.ids.next(), at: ctx.now };
      const direction = tx.ledgerDirectionFor(ref);
      let entry;
      try {
        entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      } catch (e) {
        if (e instanceof InsufficientFundsError) {
          throw new BusinessRuleViolation(
            tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw,
          );
        }
        throw e;
      }
      tx.markProcessed(ref?.id, ctx.now, wallet.balance);
      await repos.ledger.append(entry);
      await repos.wallets.save(wallet, expectedVersion);
      await repos.transactions.save(tx);
      events.push(WagerTransactionProcessed.from(tx, this.eventCtx(ctx)));
      events.push(WalletBalanceChanged.from(wallet, entry, this.eventCtx(ctx)));
    }

    await repos.outbox.addAll(events.map((e) => OutboxMessage.enqueue(e)));
    this.metrics.increment('wager_transactions_total', { status: WagerTransactionStatus.Processed, kind: tx.kind });

    if (
      tx.kind === WagerTransactionKind.Bet ||
      tx.kind === WagerTransactionKind.Win ||
      tx.kind === WagerTransactionKind.Refund
    ) {
      await repos.transactions.wakePendingDependents(tx.providerId, tx.externalTransactionId, ctx.now);
    }
  }

  private async awaitReference(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    ctx: ProcessingContext,
  ): Promise<void> {
    const firstTime = tx.status === WagerTransactionStatus.Pending;
    if (!firstTime) {
      const expired = ctx.now.getTime() - tx.createdAt.getTime() >= this.policy.ttlMs;
      if (tx.pendingAttempts >= this.policy.maxAttempts || expired) {
        await this.reject(repos, wallet, tx, FailureCode.ReferenceNotFound, ctx);
        return;
      }
    }
    const attempt = firstTime ? 0 : tx.pendingAttempts + 1;
    const delay = exponentialBackoffMs(attempt, this.policy.baseBackoffMs, this.policy.capBackoffMs);
    tx.markPendingReference(new Date(ctx.now.getTime() + delay));
    await repos.transactions.save(tx);
    if (firstTime) {
      await repos.outbox.addAll([OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, this.eventCtx(ctx)))]);
      this.metrics.increment('wager_transactions_total', {
        status: WagerTransactionStatus.PendingReference,
        kind: tx.kind,
      });
    } else {
      this.metrics.increment('wager_retries_total', { component: 'pending_reference' });
    }
  }

  private async reject(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    code: FailureCode,
    ctx: ProcessingContext,
  ): Promise<void> {
    tx.reject(code, ctx.now, wallet.balance);
    await repos.transactions.save(tx);
    await repos.outbox.addAll([OutboxMessage.enqueue(WagerTransactionRejected.from(tx, this.eventCtx(ctx)))]);
    this.metrics.increment('wager_transactions_total', { status: WagerTransactionStatus.Rejected, kind: tx.kind });
  }

  private eventCtx(ctx: ProcessingContext): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
    };
  }
}
