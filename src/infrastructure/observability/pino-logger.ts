import pino, { type Logger } from 'pino';
import type { AppLogger } from '../../application/ports';

/**
 * Logs estruturados (JSON). Convenção: só ids/códigos (correlationId, messageId, transactionId, walletId,
 * providerId). Nunca logar payload financeiro completo; campos sensíveis são redigidos como defesa extra.
 */
export function createPino(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service: 'wagering-processor' },
    redact: { paths: ['money', 'payload', '*.money', '*.payload', 'balance', 'authorization'], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger = createPino()) {}
  info(message: string, context: Record<string, unknown> = {}) {
    this.logger.info(context, message);
  }
  warn(message: string, context: Record<string, unknown> = {}) {
    this.logger.warn(context, message);
  }
  error(message: string, context: Record<string, unknown> = {}) {
    this.logger.error(context, message);
  }
}

export class SilentLogger implements AppLogger {
  info() {}
  warn() {}
  error() {}
}
