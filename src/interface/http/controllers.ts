import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CreateWallet } from '../../application/create-wallet';
import { HEALTH_PROBES, type HealthProbes } from '../../application/ports';
import { Queries } from '../../application/queries';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import type { PromMetrics } from '../../infrastructure/observability/prom-metrics';
import { CreateWalletDto, SubmitTransactionDto } from './dtos';
import { CorrelationId, Public } from './http-support';
import {
  ErrorResponseModel,
  HealthLiveResponseModel,
  HealthReadyResponseModel,
  LedgerPageResponseModel,
  ReconciliationResponseModel,
  RejectedTransactionResponseModel,
  SubmitTransactionResponseModel,
  TransactionResponseModel,
  WalletResponseModel,
} from './swagger-models';

@ApiTags('Wallets')
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: Queries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Criar wallet', description: 'Cria uma wallet. Um saldo inicial positivo gera uma transação OPENING e um crédito no ledger.' })
  @ApiBody({ type: CreateWalletDto })
  @ApiResponse({ status: 201, description: 'Wallet criada.', type: WalletResponseModel })
  @ApiBadRequestResponse({ description: 'Dados inválidos.', type: ErrorResponseModel })
  @ApiConflictResponse({ description: 'Já existe uma wallet para o player e a moeda informados.', type: ErrorResponseModel })
  create(@Body() dto: CreateWalletDto, @CorrelationId() correlationId: string) {
    return this.createWallet.execute({ playerId: dto.playerId, initialBalance: dto.initialBalance, correlationId });
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Consultar wallet' })
  @ApiParam({ name: 'walletId', format: 'uuid', description: 'Identificador da wallet.' })
  @ApiOkResponse({ type: WalletResponseModel })
  @ApiBadRequestResponse({ description: 'UUID inválido.', type: ErrorResponseModel })
  @ApiNotFoundResponse({ description: 'Wallet não encontrada.', type: ErrorResponseModel })
  get(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Consultar lançamentos do ledger', description: 'Retorna uma página ordenada de forma estável. O cursor é opaco e pode ser enviado na próxima consulta.' })
  @ApiParam({ name: 'walletId', format: 'uuid', description: 'Identificador da wallet.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor opaco devolvido em nextCursor.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200, example: 50, description: 'Quantidade de itens (padrão 50; máximo 200).' })
  @ApiOkResponse({ type: LedgerPageResponseModel })
  @ApiBadRequestResponse({ description: 'UUID, cursor ou limite inválido.', type: ErrorResponseModel })
  @ApiNotFoundResponse({ description: 'Wallet não encontrada.', type: ErrorResponseModel })
  ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be an integer between 1 and 200');
    return this.queries.getLedger(walletId, cursor || undefined, n);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reconciliar saldo e ledger', description: 'Compara o saldo materializado com a soma dos lançamentos. Divergências são sinalizadas, nunca corrigidas automaticamente.' })
  @ApiParam({ name: 'walletId', format: 'uuid', description: 'Identificador da wallet.' })
  @ApiOkResponse({ type: ReconciliationResponseModel })
  @ApiBadRequestResponse({ description: 'UUID inválido.', type: ErrorResponseModel })
  @ApiNotFoundResponse({ description: 'Wallet não encontrada.', type: ErrorResponseModel })
  reconciliation(@Param('walletId', ParseUUIDPipe) walletId: string, @CorrelationId() correlationId: string) {
    return this.reconcile.execute(walletId, correlationId);
  }
}

@ApiTags('Wagering')
@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: Queries,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({ summary: 'Submeter transação de aposta', description: 'Processa BET, WIN, LOSS, REFUND ou ROLLBACK. Reenvios idênticos retornam o resultado persistido; a mesma chave com payload diferente gera conflito.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Chave persistente de idempotência (1 a 255 caracteres).', example: 'provider-a:transaction-123' })
  @ApiHeader({ name: 'X-Correlation-Id', required: false, description: 'Identificador de correlação opcional, ecoado nos logs e eventos.' })
  @ApiBody({ type: SubmitTransactionDto })
  @ApiOkResponse({ description: 'Transação processada ou replay idempotente.', type: SubmitTransactionResponseModel })
  @ApiResponse({ status: 202, description: 'Transação aceita aguardando a referência.', type: SubmitTransactionResponseModel })
  @ApiResponse({ status: 422, description: 'Rejeição de negócio persistida com failureCode estável.', type: RejectedTransactionResponseModel })
  @ApiBadRequestResponse({ description: 'Payload inválido ou header Idempotency-Key ausente.', type: ErrorResponseModel })
  @ApiNotFoundResponse({ description: 'Wallet não encontrada.', type: ErrorResponseModel })
  @ApiConflictResponse({ description: 'A chave de idempotência foi reutilizada com um payload diferente.', type: ErrorResponseModel })
  @ApiServiceUnavailableResponse({ description: 'Falha transitória. Reenvie a mesma requisição.', type: ErrorResponseModel })
  async submitTransaction(
    @Body() dto: SubmitTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 255) {
      throw new BadRequestException('Idempotency-Key header is required (1..255 chars)');
    }
    const result = await this.submit.execute({
      ...dto,
      idempotencyKey,
      correlationId,
      source: { type: 'http' },
    });

    const body = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };
    switch (result.status) {
      case WagerTransactionStatus.Processed:
        res.status(200);
        return body;
      case WagerTransactionStatus.PendingReference:
      case WagerTransactionStatus.Pending:
        res.status(202);
        return body;
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        // regra de negócio violada: 422 com failureCode estável para o provedor decidir
        res.status(422);
        return {
          ...body,
          failureCode: result.failureCode,
          error: { code: result.failureCode, message: `Transaction rejected: ${result.failureCode}`, retryable: false },
          correlationId,
        };
    }
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Consultar transação por identificador' })
  @ApiParam({ name: 'transactionId', format: 'uuid', description: 'Identificador interno da transação.' })
  @ApiOkResponse({ type: TransactionResponseModel })
  @ApiBadRequestResponse({ description: 'UUID inválido.', type: ErrorResponseModel })
  @ApiNotFoundResponse({ description: 'Transação não encontrada.', type: ErrorResponseModel })
  get(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Consultar transação por identificador do provedor' })
  @ApiParam({ name: 'providerId', description: 'Identificador do provedor.', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', description: 'Identificador externo da transação.', example: 'transaction-123' })
  @ApiOkResponse({ type: TransactionResponseModel })
  @ApiNotFoundResponse({ description: 'Transação não encontrada.', type: ErrorResponseModel })
  getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_PROBES) private readonly probes: HealthProbes) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe', description: 'Confirma que o processo está ativo; não verifica dependências externas.' })
  @ApiOkResponse({ type: HealthLiveResponseModel })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe', description: 'Verifica se PostgreSQL e SQS estão alcançáveis.' })
  @ApiOkResponse({ type: HealthReadyResponseModel })
  @ApiServiceUnavailableResponse({ description: 'Uma ou mais dependências estão indisponíveis.', type: ErrorResponseModel })
  async ready() {
    const [database, queue] = await Promise.allSettled([this.probes.database(), this.probes.queue()]);
    const state = (r: PromiseSettledResult<void>) => (r.status === 'fulfilled' ? 'up' : 'down');
    const body = { status: database.status === 'fulfilled' && queue.status === 'fulfilled' ? 'ok' : 'unavailable', database: state(database), queue: state(queue) };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}

@Public()
@ApiTags('Observability')
@Controller('metrics')
export class MetricsController {
  constructor(@Inject('PROM_METRICS') private readonly metrics: PromMetrics) {}

  @Get()
  @ApiOperation({ summary: 'Métricas Prometheus', description: 'Exposição em formato de texto Prometheus.' })
  @ApiProduces('text/plain')
  @ApiResponse({ status: 200, description: 'Métricas no formato de exposição Prometheus.', content: { 'text/plain': { schema: { type: 'string', example: '# HELP wager_transactions_total Transações por status final/intermediário' } } } })
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.render());
  }
}
