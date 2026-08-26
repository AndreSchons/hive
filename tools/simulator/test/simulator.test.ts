import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newRunId, planSchema, readySubtasks, type RunId } from '@office/protocol';
import { EventStore, openDatabase, type Db } from '@office/store';
import { buildScriptedRun, runScriptedDemo } from '../src/index';

let db: Db;
let store: EventStore;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  store = new EventStore(db);
});

afterEach(() => {
  db.close();
});

describe('roteiro', () => {
  const script = () => buildScriptedRun(newRunId(), '/tmp/projeto', 'Adicionar login');

  it('produz um plano valido segundo o protocol', () => {
    expect(() => planSchema.parse(script().plan)).not.toThrow();
  });

  it('publica o contrato antes de paralelizar as duas frentes', () => {
    const { plan, beforeBlock } = script();
    const paralelas = readySubtasks(plan, new Set());
    expect(paralelas).toHaveLength(2);
    expect(paralelas.every((subtask) => subtask.inputContracts.length > 0)).toBe(true);

    const types = beforeBlock.map((event) => event.type);
    expect(types.indexOf('contract.published')).toBeLessThan(types.indexOf('task.assigned'));
  });

  it('deixa a terceira subtask esperando as duas primeiras', () => {
    const { plan } = script();
    const [primeira, segunda, terceira] = plan.subtasks;
    expect(terceira?.dependsOn).toEqual([primeira?.id, segunda?.id]);
    expect(readySubtasks(plan, new Set([primeira?.id ?? '', segunda?.id ?? '']))).toHaveLength(1);
  });

  it('faz a pergunta ao humano em linguagem de produto, com opcoes', () => {
    const { beforeBlock } = script();
    const question = beforeBlock.find((event) => event.type === 'human.question_raised');
    if (question?.type !== 'human.question_raised') throw new Error('esperava a pergunta no roteiro');

    expect(question.payload.options.length).toBeGreaterThanOrEqual(2);
    expect(question.payload.question).not.toMatch(/Error|undefined|Property|\.ts\(/);
    expect(question.payload.context.length).toBeGreaterThan(20);
  });

  it('so aceita a entrega depois do portao verde', () => {
    const { afterAnswer } = script();
    const types = afterAnswer.map((event) => event.type);
    // O portao falha primeiro, o agente corrige, e so entao a task fecha.
    expect(types.indexOf('gate.failed')).toBeLessThan(types.indexOf('gate.passed'));
    expect(types.indexOf('gate.passed')).toBeLessThan(types.indexOf('task.completed'));
    expect(types.indexOf('task.completed')).toBeLessThan(types.indexOf('worktree.merged'));
  });
});

describe('runScriptedDemo', () => {
  it('grava a execucao inteira quando responde sozinho', async () => {
    const runId = await runScriptedDemo({
      store,
      projectPath: '/tmp/projeto',
      stepDelayMs: 0,
      autoAnswerAfterMs: 0,
    });

    const types = [...store.replay(runId)].map((event) => event.type);
    expect(types[0]).toBe('run.started');
    expect(types).toContain('plan.created');
    expect(types).toContain('contract.published');
    expect(types).toContain('human.question_raised');
    expect(types).toContain('human.answered');
    expect(types[types.length - 1]).toBe('run.completed');
    expect(store.getRun(runId)?.status).toBe('completed');
  });

  it('numera tudo em sequencia, sem buraco', async () => {
    const runId = await runScriptedDemo({
      store, projectPath: '/tmp/projeto', stepDelayMs: 0, autoAnswerAfterMs: 0,
    });
    const seqs = [...store.replay(runId)].map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it('para no bloqueio e so continua depois da resposta chegar pelo log', async () => {
    const runId: RunId = newRunId();
    const finished = runScriptedDemo({
      store, runId, projectPath: '/tmp/projeto', stepDelayMs: 0, autoAnswerAfterMs: null,
    });

    // Espera a pergunta aparecer, como o hub faria.
    const questionId = await waitFor(() => {
      const question = store.read(runId).find((event) => event.type === 'human.question_raised');
      return question?.type === 'human.question_raised' ? question.payload.questionId : null;
    });

    // Nada de gate.passed da tela antes da resposta: a execucao esta parada.
    const antes = store.read(runId).map((event) => event.type);
    expect(antes).not.toContain('run.completed');
    expect(antes.filter((type) => type === 'gate.passed')).toHaveLength(1);

    store.append(runId, {
      type: 'human.answered',
      payload: { questionId, answer: 'Bloquear por 5 minutos e avisar na tela', optionId: 'bloquear' },
    });

    await finished;
    expect(store.getRun(runId)?.status).toBe('completed');
  });

  it('encerra como falha em vez de esperar para sempre', async () => {
    const runId = await runScriptedDemo({
      store,
      projectPath: '/tmp/projeto',
      stepDelayMs: 0,
      autoAnswerAfterMs: null,
      answerTimeoutMs: 50,
    });

    const last = [...store.replay(runId)].pop();
    expect(last?.type).toBe('run.failed');
    expect(store.getRun(runId)?.status).toBe('failed');
  });

  it('reaproveita uma execucao ja criada pelo app', async () => {
    const runId = store.createRun({ projectPath: '/tmp/projeto', goal: 'Ja existia' });
    await runScriptedDemo({ store, runId, projectPath: '/tmp/projeto', stepDelayMs: 0, autoAnswerAfterMs: 0 });
    expect(store.listRuns('/tmp/projeto')).toHaveLength(1);
  });
});

async function waitFor<T>(read: () => T | null, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('a condicao nao aconteceu a tempo');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
