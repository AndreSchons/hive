import type { OfficeBridge } from '@hive/protocol';

declare global {
  interface Window {
    /** Injetado pelo preload do Electron. Ausente se a pagina abrir no navegador. */
    readonly hive?: OfficeBridge;
  }
}

export {};
