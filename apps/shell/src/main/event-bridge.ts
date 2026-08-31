import type { BrowserWindow } from 'electron';
import type { AnyEvent, RunId } from '@hive/protocol';
import { IPC_CHANNELS } from '@hive/protocol';
import { EventStore } from '@hive/store';

const POLL_INTERVAL_MS = 200;
/** Procurar execucao nova e mais barato de fazer raramente do que a cada tick. */
const DISCOVER_EVERY_MS = 1000;

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
  private projectPath: string | null = null;
  /** Quando passamos a seguir a execucao atual. Filtra execucoes antigas. */
  private followingSince = 0;
  private lastDiscovery = 0;

  constructor(
    private readonly store: EventStore,
    private readonly window: BrowserWindow,
  ) {}

  /** Passa a acompanhar uma execucao a partir de um seq. */
  follow(runId: RunId, fromSeq = 0): void {
    this.runId = runId;
    this.cursor = fromSeq;
    this.followingSince = Date.now();
    this.ensureRunning();
  }

  /**
   * Passa a acompanhar o projeto: qualquer execucao nova dele vira a execucao
   * seguida. E o que faz o simulador disparado pelo terminal aparecer na janela
   * -- e amanha e o que faz uma execucao iniciada de fora aparecer tambem.
   */
  followProject(projectPath: string): void {
    this.projectPath = projectPath;
    this.lastDiscovery = 0;
    this.ensureRunning();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.runId = null;
    this.projectPath = null;
  }

  private ensureRunning(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private tick(): void {
    // Uma leitura por vez: se o disco travar, nao empilha tick em cima de tick.
    if (this.delivering) return;
    if (this.runId === null && this.projectPath === null) return;
    if (this.window.isDestroyed()) {
      this.stop();
      return;
    }

    this.delivering = true;
    try {
      this.discover();
      if (this.runId === null) return;

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

  /**
   * Troca para a execucao mais recente do projeto, se houver uma mais nova do
   * que a que estamos seguindo. A comparacao por horario evita duas armadilhas:
   * voltar para uma execucao antiga, e roubar o foco de uma execucao que acabou
   * de ser seguida mas ainda nao gravou a primeira linha.
   */
  private discover(): void {
    if (this.projectPath === null) return;

    const now = Date.now();
    if (now - this.lastDiscovery < DISCOVER_EVERY_MS) return;
    this.lastDiscovery = now;

    const latest = this.store.latestRunOf(this.projectPath);
    if (latest === null || latest.runId === this.runId) return;
    if (latest.startedAt < this.followingSince) return;

    this.follow(latest.runId, 0);
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
