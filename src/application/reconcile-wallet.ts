import { Inject, Injectable } from '@nestjs/common';
import type { MoneyProps } from '../domain/money';
import { WalletNotFoundError } from './errors';
import { APP_LOGGER, METRICS, READ_REPOSITORIES, type AppLogger, type Metrics, type Repositories } from './ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Compara saldo materializado com o recalculado pelo ledger. NUNCA corrige: só loga, conta e sinaliza. */
@Injectable()
export class ReconcileWallet {
  constructor(
    @Inject(READ_REPOSITORIES) private readonly repos: Repositories,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string, correlationId?: string): Promise<ReconciliationReport> {
    const snap = await this.repos.ledger.reconcile(walletId);
    if (!snap) throw new WalletNotFoundError(walletId);

    const difference = snap.storedBalance.subtract(snap.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.increment('wager_reconciliation_divergences_total');
      this.logger.error('wallet reconciliation divergence', {
        walletId,
        correlationId,
        difference: difference.amount,
        checkedEntries: snap.entries,
      });
    }
    return {
      walletId,
      storedBalance: snap.storedBalance.toJSON(),
      calculatedBalance: snap.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snap.entries,
    };
  }
}
