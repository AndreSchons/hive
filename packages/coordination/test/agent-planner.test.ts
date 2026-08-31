import { describe, expect, it } from 'vitest';
import {
  adapterId,
  draft,
  newQuestionId,
  newRunId,
  roleDefinitionSchema,
  rosterSchema,
  type AgentId,
  type AnyEventDraft,
  type RoleDefinition,
} from '@office/protocol';
import type {
  AdapterProbe,
  AgentAdapter,
  AgentOutcome,
  AgentRun,
  AgentRunRequest,
} from '@office/agents';
import { AgentPlanner } from '../src/index';
import type { PlanRequest } from '../src/index';

const gerente: RoleDefinition = roleDefinitionSchema.parse({
  id: 'gerente', title: 'Gerente', adapter: 'claude', canDelegate: true,
});

const roster = rosterSchema.parse([
  { id: 'gerente', title: 'Gerente', adapter: 'claude', canDelegate: true },
  { id: 'backend', title: 'Backend', adapter: 'claude' },
  { id: 'frontend', title: 'Interface', adapter: 'claude' },
]);

/**
 * Um adaptador que devolve respostas combinadas, uma por chamada. E o que
 * permite testar o planner inteiro -- inclusive a segunda tentativa -- sem CLI.
 */
class FakeAdapter implements AgentAdapter {
  readonly id = adapterId.parse('mock');
  readonly displayName = 'Falso';
  readonly capabilities = {
    streamsJson: true, resumesSession: false, acceptsExtraDirs: false, reportsToolCalls: true,
  };
  readonly requests: AgentRunRequest[] = [];

  constructor(private readonly answers: readonly AgentOutcome[]) {}

  probe(): Promise<AdapterProbe> {
    return Promise.resolve({ available: true, version: '1', executable: 'falso' });
  }

  start(request: AgentRunRequest): AgentRun {
    this.requests.push(request);
    const outcome = this.answers[this.requests.length - 1] ?? {
      status: 'failed' as const, reason: 'o teste pediu mais respostas do que combinou',
    };
    return new FakeRun(request.agentId, outcome);
  }
}

class FakeRun implements AgentRun {
  constructor(readonly agentId: AgentId, private readonly result: AgentOutcome) {}
  async *[Symbol.asyncIterator](): AsyncIterator<AnyEventDraft> {}
  answer(): void {}
  cancel(): void {}
  get outcome(): Promise<AgentOutcome> {
    return Promise.resolve(this.result);
  }
}

const completed = (summary: string): AgentOutcome => ({ status: 'completed', summary, turns: 1 });

/**
 * O que a CLI de verdade faz ao pedir ajuda: emite o evento e **fica parada**.
 * O desfecho so resolve depois de `cancel` -- nunca sozinho.
 */
class AskingRun implements AgentRun {
  readonly agentId: AgentId;
  readonly outcome: Promise<AgentOutcome>;
  /** O que respondemos ao pedido, para o teste conferir. */
  readonly answers: { answer: string; optionId?: string }[] = [];
  private settle: (outcome: AgentOutcome) => void = () => {};
  private readonly events: AnyEventDraft[];
  private released: (() => void) | null = null;
  /** `cancel` pode chegar antes de o gerador sentar para esperar. */
  private cancelled = false;

  constructor(agentId: AgentId, cause: 'agent_asked' | 'permission', private readonly texto: string) {
    this.agentId = agentId;
    this.events = [
      draft('human.question_raised', {
        questionId: newQuestionId(),
        question: cause === 'agent_asked' ? 'Melhorar em que sentido?' : 'Rodando: which codex. Pode?',
        context:
          cause === 'agent_asked'
            ? 'Preciso saber o que te incomoda hoje.'
            : 'Isso sai do combinado para quem so deveria olhar.',
        cause,
        options: [],
        allowFreeText: true,
      }),
    ];
    this.outcome = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AnyEventDraft> {
    for (const event of this.events) yield event;
    // Sem cancelar, isto nunca termina -- que e exatamente o bug.
    if (this.cancelled) return;
    await new Promise<void>((resolve) => {
      this.released = resolve;
    });
  }

  answer(answer: string, optionId?: string): void {
    this.answers.push({ answer, ...(optionId === undefined ? {} : { optionId }) });
    // Recusado, a CLI retoma e termina o trabalho -- como a de verdade faz.
    this.cancelled = true;
    this.settle({ status: 'completed', summary: this.texto, turns: 1 });
    this.released?.();
  }

  cancel(reason: string): void {
    this.cancelled = true;
    this.settle({ status: 'cancelled', reason });
    this.released?.();
  }
}

class AskingAdapter extends FakeAdapter {
  readonly runs: AskingRun[] = [];

  constructor(
    private readonly cause: 'agent_asked' | 'permission',
    private readonly texto = '',
  ) {
    super([]);
  }

  override start(request: AgentRunRequest): AgentRun {
    this.requests.push(request);
    const run = new AskingRun(request.agentId, this.cause, this.texto);
    this.runs.push(run);
    return run;
  }
}

const request = (): PlanRequest => ({
  runId: newRunId(),
  goal: 'Adicionar login com email e senha',
  roster,
  project: {
    path: '/tmp/projeto',
    baseBranch: 'main',
    availableGates: [{ kind: 'typecheck', command: 'pnpm typecheck' }],
  },
});

const rascunho = (extra = '') => `\`\`\`json
{
  "subtasks": [
    {
      "id": "schema-do-login",
      "title": "Definir o schema",
      "description": "Escrever o schema de login.",
      "role": "backend",
      "allowedPaths": ["packages/protocol"],
      "doneWhen": "O projeto continua compilando.",
      "gate": { "kind": "typecheck", "command": "pnpm typecheck" }
    },
    {
      "id": "tela-do-login",
      "title": "Montar a tela",
      "description": "Desenhar a tela de login.",
      "role": "frontend",
      "dependsOn": ["schema-do-login"],
      "allowedPaths": ["apps/hub"],
      "doneWhen": "A tela abre.",
      "gate": { "kind": "build", "command": "pnpm build" }
    }
  ]
}
\`\`\`${extra}`;

describe('AgentPlanner', () => {
  it('transforma o rascunho do modelo num plano completo', async () => {
    const adapter = new FakeAdapter([completed(rascunho())]);
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    if (result.status !== 'planned') throw new Error(`esperava plano: ${result.status}`);
    expect(result.plan.subtasks.map((subtask) => subtask.id)).toEqual([
      'schema-do-login', 'tela-do-login',
    ]);
    // Os campos do sistema entram aqui, nunca vindos do modelo.
    expect(result.plan.runId).toBeDefined();
    expect(result.plan.revision).toBe(0);
    expect(result.plan.subtasks[0]?.gate.id).toMatch(/^gat_/);
    expect(result.plan.subtasks[0]?.budget.maxTurns).toBe(30);
  });

  it('roda o gerente em modo somente-leitura', async () => {
    const adapter = new FakeAdapter([completed(rascunho())]);
    await new AgentPlanner({ adapter, role: gerente }).plan(request());

    // Planejar e olhar: sem isso o gerente teria escrita na pasta do usuario.
    expect(adapter.requests[0]?.readOnly).toBe(true);
    expect(adapter.requests[0]?.cwd).toBe('/tmp/projeto');
  });

  it('aguenta prosa em volta do JSON', async () => {
    const adapter = new FakeAdapter([completed(`Olhei o projeto.\n\n${rascunho()}\n\nQualquer duvida, me diga.`)]);
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());
    expect(result.status).toBe('planned');
  });

  it('da uma segunda chance quando o JSON nao bate com o schema', async () => {
    const quebrado = '```json\n{"subtasks": [{"id": "a", "title": "A"}]}\n```';
    const adapter = new FakeAdapter([completed(quebrado), completed(rascunho())]);
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    expect(result.status).toBe('planned');
    expect(adapter.requests).toHaveLength(2);
    // A segunda tentativa leva o erro junto: e o que o modelo conserta sozinho.
    expect(adapter.requests[1]?.prompt).toContain('nao passou na validacao');
  });

  it('desiste depois de duas tentativas, sem entrar em loop', async () => {
    const lixo = completed('nao entendi o pedido');
    const adapter = new FakeAdapter([lixo, lixo]);
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    expect(result.status).toBe('needs_input');
    expect(adapter.requests).toHaveLength(2);
  });

  it('recusa plano com ciclo, que o grafo pega antes de virar execucao', async () => {
    const ciclo = `\`\`\`json
{"subtasks": [
  {"id":"a","title":"A","description":"a","role":"backend","dependsOn":["b"],"doneWhen":"ok","gate":{"kind":"test","command":"pnpm test"}},
  {"id":"b","title":"B","description":"b","role":"backend","dependsOn":["a"],"doneWhen":"ok","gate":{"kind":"test","command":"pnpm test"}}
]}
\`\`\``;
    const adapter = new FakeAdapter([completed(ciclo), completed(ciclo)]);
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    expect(result.status).toBe('needs_input');
    expect(adapter.requests[1]?.prompt).toContain('ciclo de dependencias');
  });

  it('gerente que preferiu perguntar vira pergunta, nao falha', async () => {
    const adapter = new FakeAdapter([
      { status: 'blocked', questionId: newQuestionId(), question: 'Login com Google tambem?' },
    ]);
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    if (result.status !== 'needs_input') throw new Error('esperava pergunta');
    expect(result.question).toBe('Login com Google tambem?');
  });

  it('replaneja levando o plano anterior e o motivo', async () => {
    const adapter = new FakeAdapter([completed(rascunho()), completed(rascunho())]);
    const planner = new AgentPlanner({ adapter, role: gerente });

    const first = await planner.plan(request());
    if (first.status !== 'planned') throw new Error('esperava plano');

    const again = await planner.revise(first.plan, 'A tela ficou grande demais.');
    if (again.status !== 'planned') throw new Error('esperava plano revisado');

    expect(again.plan.revision).toBe(1);
    expect(adapter.requests[1]?.prompt).toContain('A tela ficou grande demais.');
    // Replanejar contra o mesmo projeto: a pasta nao pode ser inventada.
    expect(adapter.requests[1]?.cwd).toBe('/tmp/projeto');
  });

  it('gerente que pergunta no meio nao fica pendurado esperando resposta', async () => {
    // A CLI emite `human.question_raised` e suspende; ninguem responde a uma
    // pergunta de planejamento. Sem cancelar, isto so terminaria no orcamento.
    const adapter = new AskingAdapter('agent_asked');
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    if (result.status !== 'needs_input') throw new Error('esperava pergunta');
    expect(result.question).toBe('Melhorar em que sentido?');
    expect(result.context).toBe('Preciso saber o que te incomoda hoje.');
    // Uma tentativa so: perguntar nao e erro para tentar de novo.
    expect(adapter.requests).toHaveLength(1);
  });

  it('pedido de permissao nao vira pergunta de produto: recusa e segue', async () => {
    // O gerente tentou rodar um comando em modo somente-leitura. Isso e a nossa
    // politica barrando ele, nao duvida da pessoa -- e o texto cru da
    // ferramenta jamais pode chegar na tela como se fosse pergunta.
    const adapter = new AskingAdapter('permission', rascunho());
    const result = await new AgentPlanner({ adapter, role: gerente }).plan(request());

    expect(result.status).toBe('planned');
    expect(adapter.runs[0]?.answers[0]?.optionId).toBe('deny');
    // Uma tentativa so: recusar nao reinicia o planejamento.
    expect(adapter.requests).toHaveLength(1);
  });
});
