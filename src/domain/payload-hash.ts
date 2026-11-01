import { createHash } from 'node:crypto';
import { Money } from './money';

export interface HashableTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
}

/** JSON canônico: chaves ordenadas recursivamente, sem espaços, `undefined` omitido. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 * Fora do hash: Idempotency-Key, messageId, occurredAt e demais metadados de transporte.
 * O valor é normalizado para escala 2 ("25" e "25.00" produzem o mesmo hash).
 */
export function computePayloadHash(p: HashableTransactionPayload): string {
  const money = Money.from(p.money);
  const canonical = canonicalJson({
    providerId: p.providerId,
    externalTransactionId: p.externalTransactionId,
    playerId: p.playerId,
    walletId: p.walletId,
    roundId: p.roundId,
    gameId: p.gameId,
    kind: p.kind,
    money: money.toJSON(),
    referenceExternalTransactionId: p.referenceExternalTransactionId ?? undefined,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
