/** Backoff exponencial determinístico: base * 2^attempts, limitado por `capMs`. */
export function exponentialBackoffMs(attempts: number, baseMs = 1_000, capMs = 300_000): number {
  const exp = Math.min(attempts, 30);
  return Math.min(baseMs * 2 ** exp, capMs);
}
