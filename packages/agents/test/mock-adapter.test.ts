import { describe, expect, it } from 'vitest';
import { newAgentId, newTaskId, roleId, type AnyEventDraft } from '@office/protocol';
import { MockAdapter, createAdapterRegistry, type AgentRun, type AgentRunRequest } from '../src/index';

const request = (): AgentRunRequest => ({
  agentId: newAgentId('backend'),
  role: roleId.parse('backend'),
  taskId: newTaskId(),
  cwd: '/tmp/worktrees/backend',
  prompt: 'Criar a rota de login com email e senha',
  allowedPaths: ['src/api'],
  contracts: [],
  budget: { maxTurns: 30, maxDurationMs: 900_000, maxRepeats: 2 },
});

async function collect(run: AgentRun): Promise<AnyEventDraft[]> {
  const events: AnyEventDraft[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('MockAdapter', () => {
  it('declara suas capacidades e responde ao probe', async () => {
    const adapter = new MockAdapter();
    expect(adapter.capabilities.resumesSession).toBe(true);
    await expect(adapter.probe()).resolves.toMatchObject({ available: true });
  });

  it('emite uma sequencia plausivel e termina', async () => {
    const run = new MockAdapter().start(request());
    const events = await collect(run);
    const types = events.map((event) => event.type);

    expect(types[0]).toBe('agent.spawned');
    expect(types).toContain('task.started');
    expect(types).toContain('tool.call');
    expect(types).toContain('file.changed');
    expect(types).toContain('gate.passed');
    expect(types.indexOf('gate.passed')).toBeLessThan(types.indexOf('task.completed'));
    expect(types[types.length - 1]).toBe('agent.state_changed');

    await expect(run.outcome).resolves.toMatchObject({ status: 'completed' });
  });

  it('so passa por gate.passed depois de gate.started', async () => {
    const events = await collect(new MockAdapter().start(request()));
    const types = events.map((event) => event.type);
    expect(types.indexOf('gate.started')).toBeLessThan(types.indexOf('gate.passed'));
  });

  it('trava, pergunta ao humano e so continua depois da resposta', async () => {
    const adapter = new MockAdapter({
      blockWith: {
        question: 'Devo usar o banco de dados que ja existe no projeto?',
        context: 'Encontrei duas conexoes configuradas e nao sei qual e a boa.',
        options: [{ id: 'sim', label: 'Sim, usar o que ja existe' }],
      },
    });
    const run = adapter.start(request());

    const before: AnyEventDraft[] = [];
    const iterator = run[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) throw new Error('a execucao terminou sem perguntar');
      before.push(next.value);
      if (next.value.type === 'human.question_raised') break;
    }

    const blocked = before.find(
      (event) => event.type === 'agent.state_changed' && event.payload.to === 'blocked',
    );
    expect(blocked).toBeDefined();

    const question = before[before.length - 1];
    expect(question?.type).toBe('human.question_raised');
    if (question?.type === 'human.question_raised') {
      expect(question.payload.options[0]?.label).toBe('Sim, usar o que ja existe');
      expect(question.payload.askedBy).toBeDefined();
    }

    run.answer('Sim, usar o que ja existe');

    const after: AnyEventDraft[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      after.push(next.value);
    }

    expect(after.map((event) => event.type)).toContain('human.answered');
    await expect(run.outcome).resolves.toMatchObject({ status: 'completed' });
  });

  it('reporta falha de portao como task.failed, sem inventar entrega', async () => {
    const run = new MockAdapter({ failGate: 'O typecheck acusou 3 erros no arquivo de rotas.' }).start(
      request(),
    );
    const types = (await collect(run)).map((event) => event.type);

    expect(types).toContain('gate.failed');
    expect(types).toContain('task.failed');
    expect(types).not.toContain('task.completed');
    await expect(run.outcome).resolves.toMatchObject({ status: 'failed' });
  });

  it('cancela uma execucao travada em vez de deixa-la pendurada', async () => {
    const run = new MockAdapter({
      blockWith: { question: 'Continuo?', context: 'Parei numa duvida.' },
    }).start(request());

    const iterator = run[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done === true || next.value.type === 'human.question_raised') break;
    }
    run.cancel('usuario fechou a janela');

    await expect(run.outcome).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('gera worktree e branch proprios por agente', async () => {
    const [a, b] = await Promise.all([
      collect(new MockAdapter().start({ ...request(), cwd: '/tmp/wt/a' })),
      collect(new MockAdapter().start({ ...request(), cwd: '/tmp/wt/b' })),
    ]);

    const spawnA = a[0];
    const spawnB = b[0];
    if (spawnA?.type !== 'agent.spawned' || spawnB?.type !== 'agent.spawned') {
      throw new Error('esperava agent.spawned no inicio');
    }
    expect(spawnA.payload.worktreePath).not.toBe(spawnB.payload.worktreePath);
    expect(spawnA.payload.agentId).not.toBe(spawnB.payload.agentId);
  });
});

describe('createAdapterRegistry', () => {
  it('indexa adaptadores pelo id declarado no roster', () => {
    const adapter = new MockAdapter();
    const registry = createAdapterRegistry([adapter]);
    expect(registry.get(adapter.id)).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
  });

  it('recusa dois adaptadores com o mesmo id', () => {
    expect(() => createAdapterRegistry([new MockAdapter(), new MockAdapter()])).toThrow(/duplicado/);
  });
});
