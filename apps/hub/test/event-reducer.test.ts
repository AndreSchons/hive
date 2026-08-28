import { describe, expect, it } from 'vitest';
import { newRunId, parseEvent, SCHEMA_VERSION, type AnyEvent } from '@office/protocol';
import { buildScriptedRun } from '@office/simulator';
import { applyAll, applyEvent, emptyWorld, FEED_LIMIT } from '../src/state/event-reducer';
import { adapterLabel, describeEvent } from '../src/state/describe';

const runId = newRunId();

/** Sela drafts como o event store faria, para o redutor ver eventos de verdade. */
function seal(drafts: readonly { type: string; payload: unknown }[], from = 0): AnyEvent[] {
  return drafts.map((draft, index) =>
    parseEvent({
      schemaVersion: SCHEMA_VERSION,
      id: `evt_${from + index + 1}`,
      runId,
      seq: from + index + 1,
      ts: 1_700_000_000_000 + index * 1000,
      ...draft,
    }),
  );
}

const script = buildScriptedRun(runId, '/tmp/projeto', 'Adicionar login');
const beforeBlock = seal(script.beforeBlock);
const afterAnswer = seal(script.afterAnswer, beforeBlock.length);

describe('applyEvent', () => {
  it('parte de um mundo vazio', () => {
    expect(emptyWorld.status).toBe('idle');
    expect(emptyWorld.feed).toEqual([]);
  });

  it('reconstroi o mundo ate o bloqueio', () => {
    const world = applyAll(emptyWorld, beforeBlock);

    expect(world.runId).toBe(runId);
    expect(world.status).toBe('running');
    expect(world.goal).toBe('Adicionar login');
    expect(Object.keys(world.agents)).toHaveLength(3);
    expect(world.plan?.subtasks).toHaveLength(3);
    expect(world.contracts).toHaveLength(1);
  });

  it('deixa a pergunta pendente quando o agente trava', () => {
    const world = applyAll(emptyWorld, beforeBlock);

    expect(world.questions).toHaveLength(1);
    expect(world.questions[0]?.options.length).toBeGreaterThanOrEqual(2);
    expect(world.agents[script.frontend]?.state).toBe('blocked');
  });

  it('limpa a pergunta quando a resposta chega pelo log', () => {
    const world = applyAll(applyAll(emptyWorld, beforeBlock), afterAnswer);

    expect(world.questions).toHaveLength(0);
    expect(world.status).toBe('completed');
    expect(world.agents[script.frontend]?.state).toBe('done');
  });

  it('guarda o consumo do agente por modelo, e nao um total so', () => {
    const world = applyAll(emptyWorld, beforeBlock);
    const gerente = world.agents[script.manager];

    // Uma execucao da CLI mistura modelos: ela usa um barato para trabalho
    // interno dela. Somar tudo esconderia de qual modelo saiu o dinheiro, que e
    // a unica pergunta que este numero existe para responder.
    expect(gerente?.usage.map((item) => item.model)).toEqual([
      'claude-opus-4-6',
      'claude-haiku-4-5',
    ]);
    expect(gerente?.usage[0]?.tokens).toBeGreaterThan(0);
  });

  it('soma no mesmo modelo quando o consumo chega de novo', () => {
    const world = applyAll(applyAll(emptyWorld, beforeBlock), afterAnswer);
    const gerente = world.agents[script.manager];
    const opus = gerente?.usage.filter((item) => item.model === 'claude-opus-4-6');

    // O roteiro reporta opus duas vezes (planejar e integrar): vira um item so.
    expect(opus).toHaveLength(1);
    expect(opus?.[0]?.costUsd).toBeCloseTo(0.2417 + 0.0912, 6);
  });

  it('CLI que nao reporta consumo fica com a lista vazia, nunca com zero', () => {
    const world = applyAll(applyAll(emptyWorld, beforeBlock), afterAnswer);

    // O ACP do Kimi nao reporta. Ausente e diferente de gratis, e o unico jeito
    // de a tela saber a diferenca e a lista nao ganhar um item zerado.
    expect(world.agents[script.frontend]?.usage).toEqual([]);
  });

  it('guarda o alias de modelo pedido, e null quando o papel nao escolhe', () => {
    const world = applyAll(emptyWorld, beforeBlock);

    expect(world.agents[script.manager]?.model).toBe('opus');
    expect(world.agents[script.frontend]?.model).toBeNull();
  });

  it('o total da execucao continua batendo com a soma dos agentes', () => {
    const world = applyAll(applyAll(emptyWorld, beforeBlock), afterAnswer);
    const soma = Object.values(world.agents)
      .flatMap((agent) => agent.usage)
      .reduce((total, item) => total + item.costUsd, 0);

    expect(world.costUsd).toBeCloseTo(soma, 6);
  });

  it('leva toda subtask do plano a concluida no fim', () => {
    const world = applyAll(applyAll(emptyWorld, beforeBlock), afterAnswer);
    const statuses = Object.values(world.tasks).map((task) => task.status);

    expect(statuses).toHaveLength(3);
    expect(statuses.every((status) => status === 'done')).toBe(true);
  });

  it('guarda quem atribuiu e para quem', () => {
    const world = applyAll(emptyWorld, beforeBlock);
    const assigned = Object.values(world.tasks).filter((task) => task.assignedTo !== null);

    expect(assigned.length).toBeGreaterThan(0);
    for (const task of assigned) {
      expect(task.assignedBy).toBe(script.manager);
    }
  });

  it('devolve a task para o agente quando o portao falha', () => {
    const upToFailure: AnyEvent[] = [];
    for (const event of [...beforeBlock, ...afterAnswer]) {
      upToFailure.push(event);
      if (event.type === 'gate.failed') break;
    }

    const world = applyAll(emptyWorld, upToFailure);
    const failedGate = upToFailure[upToFailure.length - 1];
    if (failedGate?.type !== 'gate.failed') throw new Error('esperava gate.failed');

    // Nem 'done' nem 'failed': volta a ser trabalho em andamento.
    expect(world.tasks[failedGate.payload.taskId]?.status).toBe('running');
  });

  it('ignora evento repetido ou fora de ordem', () => {
    const world = applyAll(emptyWorld, beforeBlock);
    const first = beforeBlock[0];
    if (first === undefined) throw new Error('roteiro vazio');

    const again = applyEvent(world, first);
    expect(again).toBe(world);
    expect(again.feed).toHaveLength(world.feed.length);
  });

  it('recomeca do zero quando chega outra execucao', () => {
    const world = applyAll(emptyWorld, beforeBlock);
    const other = parseEvent({
      schemaVersion: SCHEMA_VERSION,
      id: 'evt_outro',
      runId: newRunId(),
      seq: 1,
      ts: Date.now(),
      type: 'run.started',
      payload: { projectPath: '/tmp/projeto', goal: 'Outra coisa', startedBy: 'human' },
    });

    const next = applyEvent(world, other);
    expect(next.goal).toBe('Outra coisa');
    expect(Object.keys(next.agents)).toHaveLength(0);
    expect(next.feed).toHaveLength(1);
  });

  it('e puro: nao muda o estado que recebeu', () => {
    const world = applyAll(emptyWorld, beforeBlock);
    const snapshot = JSON.stringify(world);
    applyAll(world, afterAnswer);
    expect(JSON.stringify(world)).toBe(snapshot);
  });

  it('reproduz o mesmo mundo em qualquer lote', () => {
    const todos = [...beforeBlock, ...afterAnswer];
    const deUmaVez = applyAll(emptyWorld, todos);

    let emLotes = emptyWorld;
    for (let index = 0; index < todos.length; index += 7) {
      emLotes = applyAll(emLotes, todos.slice(index, index + 7));
    }
    expect(JSON.stringify(emLotes)).toBe(JSON.stringify(deUmaVez));
  });

  it('nao deixa o feed crescer sem limite', () => {
    const muitos = seal(
      Array.from({ length: FEED_LIMIT + 50 }, () => ({
        type: 'task.progress',
        payload: { taskId: 'tsk_x', agentId: script.frontend, note: 'andando' },
      })),
    );
    expect(applyAll(emptyWorld, muitos).feed).toHaveLength(FEED_LIMIT);
  });
});

/**
 * Isolamento por worktree visto de fora: o hub nao sabe o que e git, mas
 * precisa mostrar de quem e cada copia e quando dois trabalhos se cruzam.
 */
describe('worktree', () => {
  const agentId = script.frontend;

  it('guarda a copia do agente mesmo chegando antes de ele entrar', () => {
    // `worktree.created` vem primeiro e e quem sabe o branch: a CLI nao sabe.
    const world = applyAll(
      emptyWorld,
      seal([
        {
          type: 'worktree.created',
          payload: { agentId, path: '/copias/frontend', branch: 'office/frontend', base: 'main' },
        },
        {
          type: 'agent.spawned',
          payload: {
            agentId, role: 'frontend', displayName: 'Interface', adapter: 'kimi',
            worktreePath: '/copias/frontend',
          },
        },
      ]),
    );

    expect(world.agents[agentId]?.branch).toBe('office/frontend');
    expect(world.agents[agentId]?.displayName).toBe('Interface');
  });

  it('conta o conflito sem despejar nome de arquivo na frase principal', () => {
    const [conflito] = seal([
      {
        type: 'worktree.conflict',
        payload: {
          agentId, taskId: 'tsk_x', branch: 'office/frontend', into: 'main',
          files: ['src/telas/Login.tsx'],
        },
      },
    ]);
    if (conflito === undefined) throw new Error('esperava o evento de conflito');

    const item = describeEvent(conflito);
    expect(item.tone).toBe('warn');
    expect(item.text).not.toMatch(/Login\.tsx/);
    expect(item.detail).toMatch(/Login\.tsx/);
  });

  it('diz quando foi um agente que juntou os dois trabalhos', () => {
    const [sozinho, juntado] = seal([
      {
        type: 'worktree.merged',
        payload: { agentId, taskId: 'tsk_x', branch: 'office/a', into: 'main', filesChanged: 2 },
      },
      {
        type: 'worktree.merged',
        payload: {
          agentId, taskId: 'tsk_x', branch: 'office/b', into: 'main', filesChanged: 2,
          resolvedBy: script.manager,
        },
      },
    ]);
    if (sozinho === undefined || juntado === undefined) throw new Error('esperava os dois merges');

    expect(describeEvent(sozinho).text).not.toMatch(/juntou os dois/);
    expect(describeEvent(juntado).text).toMatch(/juntou os dois/);
  });
});

describe('describeEvent', () => {
  it('descreve todo evento do roteiro sem vazar termo tecnico na frase', () => {
    for (const event of [...beforeBlock, ...afterAnswer]) {
      const item = describeEvent(event);
      expect(item.text.length).toBeGreaterThan(0);
      expect(item.text).not.toMatch(/undefined|\[object|Error:|\.ts\(\d/);
    }
  });

  it('separa o detalhe tecnico do texto principal', () => {
    const failure = afterAnswer.find((event) => event.type === 'gate.failed');
    if (failure === undefined) throw new Error('esperava gate.failed no roteiro');

    const item = describeEvent(failure);
    expect(item.tone).toBe('bad');
    expect(item.detail).toMatch(/Login\.tsx/);
    expect(item.text).not.toMatch(/Login\.tsx/);
  });
});

/**
 * "Qual IA esta fazendo isso" precisa ter resposta na tela. O papel nomeia o
 * personagem; a CLI e um dado separado, e nenhum dos dois pode sequestrar o
 * campo do outro.
 */
describe('qual CLI executa o agente', () => {
  it('guarda o papel como nome e a CLI como dado a parte', () => {
    const world = applyAll(
      emptyWorld,
      seal([
        {
          type: 'agent.spawned',
          payload: {
            agentId: script.frontend, role: 'frontend', displayName: 'Interface e 3D',
            adapter: 'kimi', worktreePath: '/copias/frontend',
          },
        },
      ]),
    );

    const agent = world.agents[script.frontend];
    expect(agent?.displayName).toBe('Interface e 3D');
    expect(agent?.adapter).toBe('kimi');
  });
});

describe('adapterLabel', () => {
  it('traduz o id da CLI para um nome que a pessoa reconhece', () => {
    expect(adapterLabel('kimi')).toBe('Kimi');
    expect(adapterLabel('claude')).toBe('Claude Code');
  });

  it('mostra o id cru em vez de sumir com uma CLI que nao conhece', () => {
    // Papeis sao configuracao: um adaptador novo nao pode virar um espaco vazio.
    expect(adapterLabel('gemini')).toBe('gemini');
  });
});
