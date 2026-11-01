import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  PENDING_REFERENCE_POLICY,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type PendingReferencePolicy,
  type UnitOfWork,
} from './ports';
import { WagerTransactionProcessor } from './wager-transaction-processor';

/**
 * Reprocessa transações PENDING_REFERENCE vencidas. Cada transação roda na SUA PRÓPRIA transação SQL
 * (lock da linha com SKIP LOCKED + lock da wallet): nunca seguramos locks de várias wallets ao mesmo
 * tempo, o que elimina deadlock entre workers concorrentes.
 */
@Injectable()
export class ReprocessPendingReferences {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY) private readonly policy: PendingReferencePolicy,
    private readonly processor: WagerTransactionProcessor,
  ) {}

  /** Devolve quantas transações foram examinadas. */
  async execute(): Promise<number> {
    let handled = 0;
    while (handled < this.policy.batchSize) {
      const progressed = await this.uow.run(async (repos) => {
        const now = this.clock.now();
        const tx = await repos.transactions.lockNextDuePendingReference(now);
        if (!tx) return false;
        const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) return false; // FK garante existência; defensivo
        await this.processor.apply(repos, wallet, tx, {
          now,
          correlationId: this.ids.next(),
          causationId: tx.id,
        });
        return true;
      });
      if (!progressed) break;
      handled += 1;
    }
    return handled;
  }
}
