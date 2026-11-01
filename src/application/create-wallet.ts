import { Inject, Injectable } from '@nestjs/common';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/integration-events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { WalletAlreadyExistsError } from './errors';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK, type Clock, type IdGenerator, type UnitOfWork } from './ports';
import { SYSTEM_PROVIDER_ID } from './submit-wager-transaction';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

@Injectable()
export class CreateWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);
    const now = this.clock.now();

    return this.uow.run(async (repos) => {
      const wallet = Wallet.open({ id: this.ids.next(), playerId: cmd.playerId, initialBalance, now });
      if (!(await repos.wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(cmd.playerId, initialBalance.currency);
      }

      // Saldo inicial > 0 => transação interna OPENING + lançamento CREDIT, na MESMA transação SQL.
      const entry = wallet.openingEntry({ transactionId: this.ids.next(), entryId: this.ids.next(), at: now });
      if (entry) {
        const key = `opening:${wallet.id}`;
        const tx = WagerTransaction.create({
          id: entry.transactionId,
          providerId: SYSTEM_PROVIDER_ID,
          externalTransactionId: key,
          idempotencyKey: key,
          payloadHash: 'opening',
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          createdAt: now,
          internal: true,
        });
        await repos.transactions.insertIfAbsent(tx);
        await repos.ledger.append(entry);
        tx.markProcessed(undefined, now, wallet.balance);
        await repos.transactions.save(tx);

        const ctx = () => ({ eventId: this.ids.next(), correlationId: cmd.correlationId, occurredAt: now });
        await repos.outbox.addAll([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx())),
        ]);
      }
      return toWalletView(wallet);
    });
  }
}
