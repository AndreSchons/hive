import type { BrowserWindow } from 'electron';
import type { AnyEvent, RunId } from '@office/protocol';
import { IPC_CHANNELS } from '@office/protocol';
import { EventStore } from '@office/store';

const POLL_INTERVAL_MS = 200;

/**
 * Leva os eventos novos do log ate a janela.
 *
 * Le por polling porque quem escreve pode ser outro processo (hoje o simulador
 * rodando pelo terminal, amanha um agente). Quando o orquestrador passar a
 * escrever aqui dentro, o append empurra direto e este polling sai de cena.
 */
export class EventBridge {
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;
  private runId: RunId | null = null;
  private delivering = false;

  constructor(
    private readonly store: EventStore,
    private readonly window: BrowserWindow,
  ) {}

  /** Passa a acompanhar uma execucao a partir de um seq. */
  follow(runId: RunId, fromSeq = 0): void {
    this.runId = runId;
    this.cursor = fromSeq;
    this.ensureRunning();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.runId = null;
  }

  private ensureRunning(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private tick(): void {
    // Uma leitura por vez: se o disco travar, nao empilha tick em cima de tick.
    if (this.delivering || this.runId === null) return;
    if (this.window.isDestroyed()) {
      this.stop();
      return;
    }

    this.delivering = true;
    try {
      const events = this.store.read(this.runId, this.cursor);
      if (events.length > 0) {
        this.deliver(this.runId, events);
      }
    } catch (error) {
      // Log corrompido nao pode matar a janela. Para de seguir esta execucao e
      // deixa o erro visivel no terminal de quem esta desenvolvendo.
      console.error('[event-bridge] falha ao ler eventos:', error);
      this.stop();
    } finally {
      this.delivering = false;
    }
  }

  private deliver(runId: RunId, events: readonly AnyEvent[]): void {
    const last = events[events.length - 1];
    if (last === undefined) return;

    try {
      this.window.webContents.send(IPC_CHANNELS.events, { runId, events });
      this.cursor = last.seq;
    } catch (error) {
      // A janela pode fechar entre o isDestroyed() e o send(). Nao avanca o
      // cursor: se a janela voltar, estes eventos vao de novo.
      console.error('[event-bridge] falha ao entregar eventos:', error);
    }
  }
}
