import { execFile } from 'node:child_process';
import {
  adapterId,
  type AdapterId,
} from '@office/protocol';
import type {
  AdapterCapabilities,
  AdapterProbe,
  AgentAdapter,
  AgentRun,
  AgentRunRequest,
} from '../adapter';
import { ClaudeRun } from './claude-run';

export interface ClaudeAdapterOptions {
  /** Caminho do executavel. Por padrao o `claude` que estiver no PATH. */
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
 * A CLI do Claude Code que a pessoa ja tem instalada no terminal.
 *
 * Nao ha runtime de agente aqui e nao se chama API de modelo: o adaptador roda
 * o `claude` como processo filho e converte o stream dele em eventos.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('claude');
  readonly displayName = 'Claude Code';
  readonly capabilities = capabilities;
  private readonly executable: string;

  constructor(private readonly options: ClaudeAdapterOptions = {}) {
    this.executable = options.executable ?? 'claude';
  }

  probe(): Promise<AdapterProbe> {
    const timeout = this.options.probeTimeoutMs ?? 5_000;
    return new Promise<AdapterProbe>((resolve) => {
      execFile(this.executable, ['--version'], { timeout }, (error, stdout) => {
        if (error) {
          // CLI ausente ou sem permissao e estado esperado, nao excecao: o hub
          // precisa mostrar isso como uma frase, nao como uma falha.
          resolve({
            available: false,
            reason:
              'nodeError' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'O Claude Code nao esta instalado neste computador.'
                : `Nao consegui rodar o Claude Code: ${error.message}`,
          });
          return;
        }
        const version = stdout.trim().split(/\s+/)[0] ?? 'desconhecida';
        resolve({ available: true, version, executable: this.executable });
      });
    });
  }

  start(request: AgentRunRequest): AgentRun {
    return new ClaudeRun(
      request,
      {
        agentId: request.agentId,
        role: request.role,
        displayName: this.displayName,
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
