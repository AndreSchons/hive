import type { RunId } from '@hive/protocol';
import { newRunId } from '@hive/protocol';
import type { EventStore } from '@hive/store';
import { buildScriptedRun } from './script';

export interface ScriptedDemoOptions {
  readonly store: EventStore;
  readonly projectPath: string;
  readonly goal?: string;
  /** Fixe o id para poder seguir a execucao antes dela comecar a gravar. */
  readonly runId?: RunId;
  /** Pausa entre eventos. O padrao deixa a cena 3D acompanhar a olho nu. */
  readonly stepDelayMs?: number;
  /**
   * Responde a pergunta sozinho depois deste tempo. `null` (padrao) espera a
   * resposta de verdade -- e a resposta que valida o caminho de escalonamento.
   */
  readonly autoAnswerAfterMs?: number | null;
  /** Desiste de esperar o humano e encerra a execucao como falha. */
  readonly answerTimeoutMs?: number;
}

const DEFAULT_STEP_DELAY_MS = 450;
const DEFAULT_ANSWER_TIMEOUT_MS = 10 * 60_000;

/**
 * Injeta uma execucao roteirizada no event store, incluindo o bloqueio que gera
 * a pergunta ao humano. Nao roda agente nenhum: so escreve eventos validos, na
 * ordem, com a mesma forma que o orquestrador real vai produzir.
 */
export async function runScriptedDemo(options: ScriptedDemoOptions): Promise<RunId> {
  const {
    store,
    projectPath,
    goal = 'Adicionar login com email e senha',
    stepDelayMs = DEFAULT_STEP_DELAY_MS,
    autoAnswerAfterMs = null,
    answerTimeoutMs = DEFAULT_ANSWER_TIMEOUT_MS,
  } = options;

  const runId = options.runId ?? newRunId();
  if (!store.hasRun(runId)) {
    store.createRun({ runId, projectPath, goal });
  }

  const script = buildScriptedRun(runId, projectPath, goal);

  try {
    for (const event of script.beforeBlock) {
      store.append(runId, event);
      await pause(stepDelayMs);
    }

    if (autoAnswerAfterMs !== null) {
      await pause(autoAnswerAfterMs);
      store.append(runId, {
        type: 'human.answered',
        payload: { questionId: script.questionId, answer: 'Bloquear por 5 minutos e avisar na tela', optionId: 'bloquear' },
      });
    }

    const answered = await waitForAnswer(store, runId, answerTimeoutMs);
    if (!answered) {
      store.closeRun(
        runId,
        {
          type: 'run.failed',
          payload: {
            reason: 'A execucao simulada parou de esperar a resposta.',
            detail: `nenhum human.answered em ${Math.round(answerTimeoutMs / 1000)}s`,
          },
        },
        'failed',
      );
      return runId;
    }

    // O ultimo evento do roteiro e `run.completed`: ele fecha a execucao junto,
    // para o log e a tabela nunca discordarem.
    const terminal = script.afterAnswer[script.afterAnswer.length - 1];
    for (const event of script.afterAnswer.slice(0, -1)) {
      store.append(runId, event);
      await pause(stepDelayMs);
    }
    if (terminal === undefined) {
      throw new Error('o roteiro nao tem evento final');
    }
    store.closeRun(runId, terminal, 'completed');
  } catch (error) {
    // Falha do proprio simulador vira evento tambem: o hub nao pode ficar com
    // uma execucao pendurada em 'running' para sempre.
    store.closeRun(
      runId,
      {
        type: 'run.failed',
        payload: {
          reason: 'A execucao simulada foi interrompida por um erro.',
          detail: error instanceof Error ? error.message : String(error),
        },
      },
      'failed',
    );
    throw error;
  }

  return runId;
}

/**
 * Espera `human.answered` aparecer no log. A resposta chega por outro caminho
 * -- o usuario clicando na janela -- entao o simulador le o proprio log em vez
 * de expor um callback: o log e a unica fonte de verdade.
 */
async function waitForAnswer(store: EventStore, runId: RunId, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;

  while (Date.now() < deadline) {
    const events = store.read(runId, cursor);
    for (const event of events) {
      cursor = event.seq;
      if (event.type === 'human.answered') return true;
    }
    await pause(150);
  }
  return false;
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export { buildScriptedRun, type ScriptedRun } from './script';
