/**
 * Instância de consumidor que MORRE (kill do processo) logo depois do COMMIT e ANTES do ack:
 * assim que o primeiro DeleteMessage seria enviado, o processo sai com código 137.
 * uso: bun crash-consumer.ts '<json { mainUrl, dlqUrl, eventsUrl }>'
 */
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsConsumer } from '../../src/infrastructure/messaging/sqs-consumer';
import { SilentLogger } from '../../src/infrastructure/observability/pino-logger';
import { createHarness } from './harness';

const urls = JSON.parse(process.argv[2]!) as { mainUrl: string; dlqUrl: string; eventsUrl: string };
const base = loadConfig();
const cfg = {
  ...base,
  queues: { transactionsUrl: urls.mainUrl, dlqUrl: urls.dlqUrl, eventsUrl: urls.eventsUrl },
  consumer: { ...base.consumer, waitTimeSeconds: 1 },
};

const real = createSqsClient(cfg.aws);
const sqs = new Proxy(real, {
  get(target, prop) {
    if (prop === 'send') {
      return (command: unknown, options?: unknown) => {
        if (command instanceof DeleteMessageCommand) {
          console.log('COMMITTED-BEFORE-ACK');
          process.exit(137); // morte súbita: nada de finally, nada de ack
        }
        return (target.send as any)(command, options);
      };
    }
    const v = Reflect.get(target, prop);
    return typeof v === 'function' ? v.bind(target) : v;
  },
}) as typeof real;

const h = await createHarness({ poolMax: 5 });
new SqsConsumer(sqs, h.submit, cfg, h.metrics, new SilentLogger()).start();
setTimeout(() => {
  console.log('TIMEOUT-NO-MESSAGE');
  process.exit(2);
}, 30_000);
