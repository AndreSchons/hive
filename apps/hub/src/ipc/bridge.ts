import type {
  CommandInput,
  CommandName,
  CommandResponse,
  EventBatch,
  OfficeBridge,
} from '@hive/protocol';

/**
 * Acesso a ponte. Abrir a pagina direto no navegador (sem Electron) e situacao
 * possivel durante o desenvolvimento, entao vira estado tratado e nao crash.
 */
export function getBridge(): OfficeBridge | null {
  return typeof window === 'undefined' ? null : (window.hive ?? null);
}

export const isInsideApp = (): boolean => getBridge() !== null;

const OFFLINE = {
  message: 'Esta pagina esta aberta fora do aplicativo, entao nao consegue falar com o projeto.',
  detail: 'window.hive nao foi injetado -- abra pelo Hive em vez do navegador.',
} as const;

/** Invoca um comando. Nunca lanca: falha e resposta. */
export async function invoke<N extends CommandName>(
  name: N,
  input: CommandInput<N>,
): Promise<CommandResponse<N>> {
  const bridge = getBridge();
  if (bridge === null) return { ok: false, error: OFFLINE };
  return bridge.invoke(name, input);
}

export function onEvents(listener: (batch: EventBatch) => void): () => void {
  const bridge = getBridge();
  if (bridge === null) return () => {};
  return bridge.onEvents(listener);
}
