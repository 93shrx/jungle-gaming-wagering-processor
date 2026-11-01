import type { AppLogger } from '../../application/ports';

/**
 * Loop periódico com parada graciosa: `stop()` aguarda a iteração corrente terminar.
 * `tick` devolve o nº de itens tratados; se > 0, roda de novo imediatamente (drena backlog).
 */
export class PollingLoop {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number | void>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        handled = Number((await this.tick()) ?? 0);
      } catch (e) {
        this.logger.error(`${this.name} iteration failed`, { error: e instanceof Error ? e.message : String(e) });
      }
      if (handled > 0 && this.running) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }
}
