import type { OfficeBridge } from '@office/protocol';

declare global {
  interface Window {
    /** Injetado pelo preload do Electron. Ausente se a pagina abrir no navegador. */
    readonly office?: OfficeBridge;
  }
}

export {};
