import { newRunId, parseEvent, SCHEMA_VERSION, type AnyEvent, type ProjectRef } from '@office/protocol';
import { applyAll, emptyWorld } from './state/event-reducer';
import { useHub } from './state/world-store';

/**
 * Mundo de mentira para ver o escritorio sem Electron: abrir a pagina com
 * `?demo` na URL enche a store com o roteiro do simulador ate o bloqueio (3
 * agentes em cena, um deles travado). So existe em dev -- no build de
 * producao o guarda vira codigo morto e some.
 */
export async function loadDemoWorld(): Promise<void> {
  if (!import.meta.env.DEV) return;
  if (!new URLSearchParams(window.location.search).has('demo')) return;

  const { buildScriptedRun } = await import('@office/simulator');
  const runId = newRunId();
  const script = buildScriptedRun(runId, '/tmp/demo', 'Escritorio demo');
  const events: AnyEvent[] = script.beforeBlock.map((eventDraft, index) =>
    parseEvent({
      schemaVersion: SCHEMA_VERSION,
      id: `evt_demo_${index + 1}`,
      runId,
      seq: index + 1,
      ts: 1_700_000_000_000 + index * 1000,
      ...eventDraft,
    }),
  );

  const project: ProjectRef = {
    path: '/tmp/demo',
    name: 'demo',
    lastOpenedAt: Date.now(),
    exists: true,
  };
  useHub.setState({ project, world: applyAll(emptyWorld, events) });
}
