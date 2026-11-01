import { Inject, Injectable } from '@nestjs/common';
import type { MoneyProps } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { TransactionNotFoundError, WalletNotFoundError } from './errors';
import { toWalletView, type WalletView } from './create-wallet';
import { READ_REPOSITORIES, type Repositories } from './ports';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balance: tx.observedBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class Queries {
  constructor(@Inject(READ_REPOSITORIES) private readonly repos: Repositories) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.repos.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }> {
    if (!(await this.repos.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);
    const page = await this.repos.ledger.list(walletId, cursor, limit);
    return {
      items: page.items.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async getTransaction(id: string): Promise<TransactionView> {
    const tx = await this.repos.transactions.findById(id);
    if (!tx) throw new TransactionNotFoundError(id);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.repos.transactions.findByProviderExternal(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }
}
