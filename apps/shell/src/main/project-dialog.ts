import { dialog, type BrowserWindow } from 'electron';
import { statSync } from 'node:fs';
import type { ProjectRef } from '@office/protocol';
import type { AppStore } from '@office/store';

/**
 * Dialogo nativo de selecao de pasta. Cancelar e resposta valida (null), nao
 * erro: o usuario desistir de escolher e caminho normal.
 */
export async function pickProject(
  window: BrowserWindow | null,
  store: AppStore,
): Promise<ProjectRef | null> {
  const options = {
    title: 'Escolha a pasta do projeto',
    buttonLabel: 'Abrir projeto',
    properties: ['openDirectory' as const, 'createDirectory' as const],
  };

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) return null;

  const path = result.filePaths[0];
  if (path === undefined) return null;

  return store.rememberProject(path);
}

/** Abre uma pasta ja conhecida, checando que ela ainda existe no disco. */
export function openProject(store: AppStore, path: string): ProjectRef {
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    isDirectory = false;
  }

  if (!isDirectory) {
    throw new Error(`A pasta ${path} nao existe mais no disco.`);
  }
  return store.rememberProject(path);
}
