import type { AnyEvent } from './events';
import type { CommandInput, CommandName, CommandResult } from './commands';

/**
 * Canais IPC. Sao dois e so dois: comando indo do renderer para o principal,
 * evento voltando. Tudo que o app faz cabe nesses dois sentidos.
 */
export const IPC_CHANNELS = {
  command: 'office:command',
  events: 'office:events',
} as const;

/** Falha de IPC e caso esperado, entao ela e valor de retorno e nao exception. */
export interface CommandFailure {
  /** Frase para o usuario. */
  readonly message: string;
  /** Detalhe tecnico, exibido so sob demanda. */
  readonly detail?: string;
}

export type CommandResponse<N extends CommandName> =
  | { readonly ok: true; readonly data: CommandResult<N> }
  | { readonly ok: false; readonly error: CommandFailure };

/** Lote de eventos empurrado do processo principal para a janela. */
export interface EventBatch {
  readonly runId: string;
  readonly events: readonly AnyEvent[];
}

/**
 * O que o preload expoe em `window.office`. Renderer e processo principal
 * derivam os tipos daqui, entao nao ha como discordarem sobre um canal.
 */
export interface OfficeBridge {
  invoke<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandResponse<N>>;
  /** Assina os eventos que chegam. Devolve a funcao que cancela a assinatura. */
  onEvents(listener: (batch: EventBatch) => void): () => void;
}
