import { execFile } from 'node:child_process';
import { adapterId, type AdapterId } from '@office/protocol';
import type {
  AdapterCapabilities,
  AdapterProbe,
  AgentAdapter,
  AgentRun,
  AgentRunRequest,
} from '../adapter';
import { KimiRun } from './kimi-run';

export interface KimiAdapterOptions {
  /** Caminho do executavel. Por padrao o `kimi` que estiver no PATH. */
  readonly executable?: string;
  readonly probeTimeoutMs?: number;
}

const capabilities: AdapterCapabilities = {
  streamsJson: true,
  resumesSession: true,
  acceptsExtraDirs: true,
  reportsToolCalls: true,
};

/**
 * O Kimi que a pessoa ja tem instalado, falado pelo Agent Client Protocol.
 *
 * Nao ha runtime de agente aqui e nao se chama API de modelo: o adaptador roda
 * `kimi acp` como processo filho e converte o protocolo dele em eventos.
 */
export class KimiAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('kimi');
  readonly displayName = 'Kimi';
  readonly capabilities = capabilities;
  private readonly executable: string;

  constructor(private readonly options: KimiAdapterOptions = {}) {
    this.executable = options.executable ?? 'kimi';
  }

  probe(): Promise<AdapterProbe> {
    const timeout = this.options.probeTimeoutMs ?? 5_000;
    return new Promise<AdapterProbe>((resolve) => {
      execFile(this.executable, ['--version'], { timeout }, (error, stdout) => {
        if (error) {
          // CLI ausente e estado esperado, nao excecao: o hub mostra isso como
          // uma frase, e a pessoa descobre que falta instalar alguma coisa.
          resolve({
            available: false,
            reason:
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'O Kimi nao esta instalado neste computador.'
                : `Nao consegui rodar o Kimi: ${error.message}`,
          });
          return;
        }
        const version = stdout.trim().split(/\s+/)[0] ?? 'desconhecida';
        resolve({ available: true, version, executable: this.executable });
      });
    });
  }

  start(request: AgentRunRequest): AgentRun {
    return new KimiRun(
      request,
      {
        agentId: request.agentId,
        role: request.role,
        displayName: request.displayName ?? this.displayName,
        adapter: this.id,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.model === undefined ? {} : { model: request.model }),
        title: shorten(request.prompt),
      },
      { executable: this.executable },
    );
  }
}

function shorten(text: string, max = 60): string {
  const clean = text.trim().split('\n')[0] ?? text;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
