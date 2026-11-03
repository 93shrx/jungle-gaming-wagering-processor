import { v7 as uuid } from 'uuid';

const baseUrl = (process.env.DEMO_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const providerId = 'demo-provider';
const externalTransactionId = `demo-${uuid()}`;
const idempotencyKey = `${providerId}:${externalTransactionId}`;

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

const health = await request<{ status: string }>('/health/ready');
if (health.body.status !== 'ok') throw new Error(`API is not ready: ${JSON.stringify(health.body)}`);

const { body: wallet } = await request<{
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
}>('/wallets', {
  method: 'POST',
  body: JSON.stringify({
    playerId: `demo-player-${uuid()}`,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  }),
});

const wager = {
  providerId,
  externalTransactionId,
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: `demo-round-${uuid()}`,
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const headers = { 'Idempotency-Key': idempotencyKey };

const first = await request<{
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
}>('/wagering/transactions', { method: 'POST', headers, body: JSON.stringify(wager) });
if (first.body.status !== 'PROCESSED' || first.body.idempotentReplay) {
  throw new Error(`Expected a new processed wager, got ${JSON.stringify(first.body)}`);
}

const replay = await request<typeof first.body>('/wagering/transactions', {
  method: 'POST',
  headers,
  body: JSON.stringify(wager),
});
if (!replay.body.idempotentReplay || replay.body.transactionId !== first.body.transactionId) {
  throw new Error(`Expected an idempotent replay, got ${JSON.stringify(replay.body)}`);
}

const [transaction, ledger, reconciliation] = await Promise.all([
  request(`/wagering/transactions/${first.body.transactionId}`),
  request(`/wallets/${wallet.id}/ledger?limit=50`),
  request<{ consistent: boolean; storedBalance: { amount: string }; calculatedBalance: { amount: string } }>(
    `/wallets/${wallet.id}/reconciliation`,
    { method: 'POST', body: '{}' },
  ),
]);
if (!reconciliation.body.consistent) {
  throw new Error(`Wallet does not reconcile with its ledger: ${JSON.stringify(reconciliation.body)}`);
}

console.log(
  JSON.stringify(
    {
      api: baseUrl,
      wallet: { id: wallet.id, playerId: wallet.playerId },
      firstSubmission: first.body,
      idempotentReplay: replay.body,
      transaction: transaction.body,
      ledger: ledger.body,
      reconciliation: reconciliation.body,
    },
    null,
    2,
  ),
);
