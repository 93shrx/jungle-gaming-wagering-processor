import {
  ArgumentsHost,
  BadRequestException,
  CanActivate,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import {
  IdempotencyConflictError,
  InvalidCursorError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { APP_LOGGER, type AppLogger } from '../../application/ports';
import { DomainError, InvalidMoneyError, InvalidTransactionError } from '../../domain/errors';

// ----------------------------------------------------------------- correlationId
export const CORRELATION_HEADER = 'x-correlation-id';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(CORRELATION_HEADER);
  const id = incoming && incoming.length <= 128 ? incoming : uuidv7();
  (req as any).correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().correlationId ?? uuidv7();
});

// -------------------------------------------------------------------- autenticação
/**
 * PONTO DE EXTENSÃO de autenticação (o desafio não pontua auth). Hoje é no-op; o desenho recomendado é
 * validar o JWT emitido por um IdP externo (Keycloak/Zitadel) via JWKS e mapear o `providerId` do token
 * para o `providerId` do corpo. Ver ARCHITECTURE.md.
 */
export interface ProviderIdentity {
  providerId?: string;
}
export interface ProviderIdentityPort {
  authenticate(req: Request): Promise<ProviderIdentity | undefined>;
}
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}

export const IS_PUBLIC = 'isPublic';
/** Marca endpoints abertos (health/metrics): nunca exigem autenticação. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const klass = ctx.getClass();
    if (Reflect.getMetadata(IS_PUBLIC, handler) || Reflect.getMetadata(IS_PUBLIC, klass)) return true;
    (ctx.switchToHttp().getRequest() as any).identity = await this.identity.authenticate(ctx.switchToHttp().getRequest());
    return true; // no-op: aceita tudo
  }
}

// ------------------------------------------------------------ mapeamento de erros
/**
 * Mapeamento ÚNICO e consistente de status HTTP (todos os endpoints):
 *   200  processada / replay          201  wallet criada
 *   202  aceita, processamento pendente (PENDING_REFERENCE)
 *   400  payload inválido (forma, Money, kind, cursor, UUID)       -> corrigir e reenviar
 *   404  wallet / transação inexistente                           -> corrigir
 *   409  conflito (idempotência com payload diferente; wallet duplicada) -> NÃO reenviar igual
 *   422  rejeição de regra de negócio (failureCode no corpo)       -> decidir pelo failureCode
 *   503  falha transitória de infraestrutura (+Retry-After)        -> reenviar a MESMA requisição é seguro
 *   500  erro inesperado
 */
export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
  correlationId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const { status, code, message, retryable } = this.map(exception);

    if (status >= 500) {
      this.logger.error('request failed', {
        correlationId: req.correlationId,
        path: req.path,
        code,
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }
    if (status === 503) res.setHeader('Retry-After', '1');
    const body: ErrorBody = { error: { code, message, retryable }, correlationId: req.correlationId };
    res.status(status).json(body);
  }

  private map(e: unknown): { status: number; code: string; message: string; retryable: boolean } {
    const msg = e instanceof Error ? e.message : 'Unexpected error';
    if (e instanceof BadRequestException) {
      const r = e.getResponse() as { message?: string | string[] };
      const m = Array.isArray(r?.message) ? r.message.join('; ') : (r?.message ?? msg);
      return { status: 400, code: 'VALIDATION_ERROR', message: m, retryable: false };
    }
    if (e instanceof InvalidMoneyError) return { status: 400, code: e.code, message: msg, retryable: false };
    if (e instanceof InvalidTransactionError) return { status: 400, code: e.code, message: msg, retryable: false };
    if (e instanceof InvalidCursorError) return { status: 400, code: e.code, message: msg, retryable: false };
    if (e instanceof WalletNotFoundError || e instanceof TransactionNotFoundError) {
      return { status: 404, code: e.code, message: msg, retryable: false };
    }
    if (e instanceof IdempotencyConflictError || e instanceof WalletAlreadyExistsError) {
      return { status: 409, code: e.code, message: msg, retryable: false };
    }
    if (e instanceof TransientInfrastructureError) {
      return { status: 503, code: e.code, message: 'Temporary failure; retry the same request', retryable: true };
    }
    if (e instanceof DomainError) return { status: 422, code: e.code, message: msg, retryable: false };
    if (e instanceof HttpException) {
      return { status: e.getStatus(), code: 'HTTP_ERROR', message: msg, retryable: e.getStatus() >= 500 };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error', retryable: false };
  }
}
