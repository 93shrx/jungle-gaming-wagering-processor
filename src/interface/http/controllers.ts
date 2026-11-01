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

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: Queries,
    private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateWalletDto, @CorrelationId() correlationId: string) {
    return this.createWallet.execute({ playerId: dto.playerId, initialBalance: dto.initialBalance, correlationId });
  }

  @Get(':walletId')
  get(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
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
  reconciliation(@Param('walletId', ParseUUIDPipe) walletId: string, @CorrelationId() correlationId: string) {
    return this.reconcile.execute(walletId, correlationId);
  }
}

@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queries: Queries,
  ) {}

  @Post('wagering/transactions')
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
  get(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_PROBES) private readonly probes: HealthProbes) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [database, queue] = await Promise.allSettled([this.probes.database(), this.probes.queue()]);
    const state = (r: PromiseSettledResult<void>) => (r.status === 'fulfilled' ? 'up' : 'down');
    const body = { status: database.status === 'fulfilled' && queue.status === 'fulfilled' ? 'ok' : 'unavailable', database: state(database), queue: state(queue) };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject('PROM_METRICS') private readonly metrics: PromMetrics) {}

  @Get()
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.render());
  }
}
