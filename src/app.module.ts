import 'reflect-metadata';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  BeforeApplicationShutdown,
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CreateWallet } from './application/create-wallet';
import {
  APP_LOGGER,
  CLOCK,
  EVENT_PUBLISHER,
  HEALTH_PROBES,
  ID_GENERATOR,
  METRICS,
  PENDING_REFERENCE_POLICY,
  READ_REPOSITORIES,
  UNIT_OF_WORK,
  type AppLogger,
  type Metrics,
} from './application/ports';
import { PublishOutbox } from './application/publish-outbox';
import { Queries } from './application/queries';
import { ReconcileWallet } from './application/reconcile-wallet';
import { ReprocessPendingReferences } from './application/reprocess-pending-references';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerTransactionProcessor } from './application/wager-transaction-processor';
import { loadConfig, type AppConfig } from './config';
import { InfraHealthProbes } from './infrastructure/health-probes';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { SqsConsumer } from './infrastructure/messaging/sqs-consumer';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { PinoAppLogger } from './infrastructure/observability/pino-logger';
import { PromMetrics } from './infrastructure/observability/prom-metrics';
import { MikroUnitOfWork } from './infrastructure/persistence/mikro-unit-of-work';
import { buildOrmConfig } from './infrastructure/persistence/orm-config';
import { SqlRepositories } from './infrastructure/persistence/sql-repositories';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { PollingLoop } from './infrastructure/workers/polling-loop';
import { HealthController, MetricsController, WageringController, WalletsController } from './interface/http/controllers';
import {
  AllExceptionsFilter,
  AuthGuard,
  correlationIdMiddleware,
  NoopProviderIdentity,
  PROVIDER_IDENTITY,
} from './interface/http/http-support';

export const CONFIG = Symbol('CONFIG');
export const SQS_CLIENT = Symbol('SQS_CLIENT');

/**
 * Processos em segundo plano (por papel/ROLE): consumidor SQS, publisher da outbox e worker de
 * referências pendentes. Em SIGTERM (`enableShutdownHooks`) tudo para de aceitar trabalho novo e conclui
 * o que está em andamento antes de fechar o pool do banco.
 */
@Injectable()
export class BackgroundRunner implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly loops: PollingLoop[] = [];
  private consumer?: SqsConsumer;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    private readonly orm: MikroORM,
    private readonly publishOutbox: PublishOutbox,
    private readonly reprocess: ReprocessPendingReferences,
    private readonly submit: SubmitWagerTransaction,
  ) {}

  onApplicationBootstrap(): void {
    const { roles, outbox, pendingReference } = this.config;
    if (roles.has('workers')) {
      this.loops.push(
        new PollingLoop('outbox-publisher', outbox.intervalMs, () => this.publishOutbox.execute(outbox.batchSize), this.logger),
        new PollingLoop('pending-reference-worker', pendingReference.intervalMs, () => this.reprocess.execute(), this.logger),
        new PollingLoop('outbox-stats', 5_000, () => this.publishOutbox.refreshStats(), this.logger),
      );
    }
    if (roles.has('consumer')) {
      this.consumer = new SqsConsumer(this.sqs, this.submit, this.config, this.metrics, this.logger);
      this.consumer.start();
    }
    for (const loop of this.loops) loop.start();
    this.logger.info('instance started', { roles: [...roles], port: this.config.port });
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('shutting down: draining in-flight work', { signal });
    await Promise.all([this.consumer?.stop(), ...this.loops.map((l) => l.stop())]);
  }

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig = loadConfig()): DynamicModule {
    const metrics = new PromMetrics();
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: 'PROM_METRICS', useValue: metrics },
        { provide: METRICS, useValue: metrics },
        { provide: APP_LOGGER, useValue: new PinoAppLogger() },
        { provide: CLOCK, useValue: new SystemClock() },
        { provide: ID_GENERATOR, useValue: new UuidV7Generator() },
        { provide: SQS_CLIENT, useValue: createSqsClient(config.aws) },
        {
          provide: MikroORM,
          useFactory: () => MikroORM.init(buildOrmConfig({ clientUrl: config.databaseUrl })),
        },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM, m: Metrics) => new MikroUnitOfWork(orm, m),
          inject: [MikroORM, METRICS],
        },
        {
          provide: READ_REPOSITORIES,
          useFactory: (orm: MikroORM) => new SqlRepositories(orm.em.fork() as any),
          inject: [MikroORM],
        },
        { provide: PENDING_REFERENCE_POLICY, useValue: config.pendingReference },
        {
          provide: EVENT_PUBLISHER,
          useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, config.queues.eventsUrl),
          inject: [SQS_CLIENT],
        },
        {
          provide: HEALTH_PROBES,
          useFactory: (orm: MikroORM, sqs: SQSClient) => new InfraHealthProbes(orm, sqs, config.queues.transactionsUrl),
          inject: [MikroORM, SQS_CLIENT],
        },
        { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        WagerTransactionProcessor,
        SubmitWagerTransaction,
        CreateWallet,
        Queries,
        ReconcileWallet,
        ReprocessPendingReferences,
        PublishOutbox,
        BackgroundRunner,
      ],
    };
  }
}

export async function createApp(config: AppConfig = loadConfig()): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: ['error', 'warn'] });
  app.use(correlationIdMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor API')
    .setDescription('API HTTP para wallets e processamento distribuído de transações de apostas.')
    .setVersion('1.0.0')
    .addTag('Wallets', 'Criação, consulta, ledger e reconciliação de wallets.')
    .addTag('Wagering', 'Submissão idempotente e consulta de transações.')
    .addTag('Health', 'Liveness e readiness da aplicação.')
    .addTag('Observability', 'Métricas Prometheus.')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument, { customSiteTitle: 'Wagering Processor API' });
  app.enableShutdownHooks();
  return app;
}
