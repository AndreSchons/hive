import { contextBridge, ipcRenderer } from 'electron';
import type {
  CommandInput,
  CommandName,
  CommandResponse,
  EventBatch,
  OfficeBridge,
} from '@hive/protocol';

/**
 * Conduite tipado e nada mais. Nao valida, nao decide, nao guarda estado: a
 * validacao acontece no processo principal, que e quem tem autoridade.
 *
 * So importa tipos do protocol -- nenhum require em tempo de execucao alem do
 * proprio electron, que e o que permite manter `sandbox: true`.
 */
const CHANNEL_COMMAND = 'hive:command';
const CHANNEL_EVENTS = 'hive:events';

const bridge: OfficeBridge = {
  async invoke<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandResponse<N>> {
    try {
      return await ipcRenderer.invoke(CHANNEL_COMMAND, { name, input });
    } catch (error) {
      // O canal caiu (processo principal reiniciando, janela fechando). E caso
      // esperado: vira resposta de falha, nao exception solta no renderer.
      return {
        ok: false,
        error: {
          message: 'A janela perdeu contato com o processo principal.',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },

  onEvents(listener: (batch: EventBatch) => void): () => void {
    const handler = (_event: unknown, batch: EventBatch): void => listener(batch);
    ipcRenderer.on(CHANNEL_EVENTS, handler);
    return () => {
      ipcRenderer.removeListener(CHANNEL_EVENTS, handler);
    };
  },
};

contextBridge.exposeInMainWorld('hive', bridge);
