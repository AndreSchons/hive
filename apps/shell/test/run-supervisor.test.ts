import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adapterId,
  draft,
  parallelismGain,
  questionId,
  rosterSchema,
  type AdapterId,
  type AnyEventDraft,
  type RunId,
} from '@hive/protocol';
import {
  AsyncQueue,
  GitWorktreeManager,
  createAdapterRegistry,
  type AgentAdapter,
  type AgentOutcome,
  type AgentRun,
  type AgentRunRequest,
} from '@hive/agents';
import { CONTRACTS_DIR, CommandGateRunner, InstallWorktreePreparer } from '@hive/coordination';
import { EventStore, openDatabase } from '@hive/store';
import { RunSupervisor } from '../src/main/run-supervisor';

/**
 * O supervisor com git de verdade e agentes falsos. Os agentes sao falsos de
 * proposito: o que esta sob teste e a fila, a integracao e o caminho de
 * conflito -- nao a CLI, que ja tem os proprios testes.
 */
const ARQUIVO = 'login.txt';

/** Um "agente" que so escreve o texto combinado e termina. */
class FakeRun implements AgentRun {
  readonly agentId;
  readonly outcome: Promise<AgentOutcome>;
  private readonly queue = new AsyncQueue<AnyEventDraft>();

  constructor(request: AgentRunRequest, texto: string) {
    this.agentId = request.agentId;
    // Texto vazio = o agente diz que terminou sem ter mexido em nada. E assim
    // que se testa quem afirma ter resolvido o conflito e nao resolveu.
    if (texto.length > 0) writeFileSync(join(request.cwd, ARQUIVO), `titulo\n${texto}\nrodape\n`);

    this.queue.push(
      draft('agent.spawned', {
        agentId: request.agentId, role: request.role, displayName: 'Falso',
        adapter: adapterId.parse('falso'), worktreePath: request.cwd,
      }),
      draft('agent.despawned', { agentId: request.agentId, reason: 'finished' }),
    );
    this.queue.close();
    this.outcome = Promise.resolve({ status: 'completed', summary: 'pronto', turns: 1 });
  }

  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
  answer(): void {}
  cancel(): void {}
}

class FakeAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('falso');
  readonly displayName = 'Falso';
  readonly capabilities = {
    streamsJson: true, resumesSession: false, acceptsExtraDirs: false, reportsToolCalls: true,
  };
  /** O texto que cada papel escreve, para forcar (ou nao) a colisao. */
  constructor(private readonly porPapel: Record<string, string>) {}

  probe() {
    return Promise.resolve({ available: true as const, version: '0.0.0', executable: 'falso' });
  }
  start(request: AgentRunRequest): AgentRun {
    return new FakeRun(request, this.porPapel[request.role] ?? 'nada');
  }
}

const ROSTER = rosterSchema.parse([
  { id: 'gerente', title: 'Gerente', adapter: 'falso', canDelegate: true, description: 'Integra.' },
  { id: 'alfa', title: 'Alfa', adapter: 'falso', canDelegate: false, description: 'Um.' },
  { id: 'beta', title: 'Beta', adapter: 'falso', canDelegate: false, description: 'Outro.' },
]);

let repo: string;
let home: string;
let events: EventStore;
const worktrees = new GitWorktreeManager();
const g = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sup-repo-'));
  home = mkdtempSync(join(tmpdir(), 'sup-home-'));
  g('init', '--initial-branch=main');
  g('config', 'user.name', 'Teste');
  g('config', 'user.email', 'teste@hive.local');
  writeFileSync(join(repo, ARQUIVO), 'titulo\nlinha dois\nrodape\n');
  g('add', '-A');
  g('commit', '-m', 'inicio');
  events = new EventStore(openDatabase({ path: ':memory:' }));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function build(porPapel: Record<string, string>): RunSupervisor {
  return new RunSupervisor(
    events,
    createAdapterRegistry([new FakeAdapter(porPapel)]),
    ROSTER,
    worktrees,
    join(home, 'worktrees'),
  );
}

/** Espera a execucao fechar, respondendo a pergunta de conflito quando ela vier. */
async function drain(
  supervisor: RunSupervisor,
  runId: RunId,
  escolha: string | null,
): Promise<ReturnType<EventStore['read']>> {
  for (let tentativa = 0; tentativa < 400; tentativa += 1) {
    const todos = events.read(runId, 0);
    for (const event of todos) {
      if (event.type === 'human.question_raised' && escolha !== null) {
        supervisor.answer(runId, event.payload.questionId, escolha, escolha);
        escolha = null;
      }
      if (event.type === 'run.completed' || event.type === 'run.failed') return todos;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('a execucao nao fechou');
}

/**
 * Igual, mas para execucao que pergunta mais de uma vez. Pergunta alem da
 * lista e respondida com "parar": um teste que erra a conta falha em vez de
 * pendurar a suite.
 */
async function drainAnswering(
  supervisor: RunSupervisor,
  runId: RunId,
  respostas: readonly string[],
): Promise<ReturnType<EventStore['read']>> {
  const respondidas = new Set<string>();
  const fila = [...respostas];

  for (let tentativa = 0; tentativa < 800; tentativa += 1) {
    const todos = events.read(runId, 0);
    for (const event of todos) {
      if (event.type === 'human.question_raised' && !respondidas.has(event.payload.questionId)) {
        respondidas.add(event.payload.questionId);
        const resposta = fila.shift() ?? 'parar';
        supervisor.answer(runId, event.payload.questionId, resposta, resposta);
      }
      if (event.type === 'run.completed' || event.type === 'run.failed') return todos;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('a execucao nao fechou');
}

const typesOf = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

const payloadsOf = <T extends string>(
  todos: ReturnType<EventStore['read']>,
  type: T,
): Extract<ReturnType<EventStore['read']>[number], { type: T }>['payload'][] =>
  todos
    .filter((event): event is Extract<typeof event, { type: T }> => event.type === type)
    .map((event) => event.payload);

describe('guardas de entrada', () => {
  it('recusa pasta que nao e repositorio, com frase e nao excecao tecnica', async () => {
    const solta = mkdtempSync(join(tmpdir(), 'sup-solta-'));
    await expect(
      build({}).start({ projectPath: solta, tasks: [{ goal: 'algo', role: 'alfa' }] }),
    ).rejects.toThrow(/repositorio git/);
    rmSync(solta, { recursive: true, force: true });
  });

  it('recusa comecar com mudanca nao salva da pessoa', async () => {
    writeFileSync(join(repo, ARQUIVO), 'algo que eu estava escrevendo\n');
    await expect(
      build({}).start({ projectPath: repo, tasks: [{ goal: 'algo', role: 'alfa' }] }),
    ).rejects.toThrow(/nao salvas/);
  });
});

describe('fila em sequencia', () => {
  it('da uma copia para cada agente e integra as duas quando nao colidem', async () => {
    const supervisor = build({ alfa: 'linha dois', beta: 'linha dois' });
    const runId = await supervisor.start({
      projectPath: repo,
      tasks: [
        { goal: 'primeira', role: 'alfa' },
        { goal: 'segunda', role: 'beta' },
      ],
    });
    const todos = await drain(supervisor, runId, null);

    expect(typesOf(todos).filter((type) => type === 'worktree.created')).toHaveLength(2);
    expect(typesOf(todos).at(-1)).toBe('run.completed');

    // Nenhuma copia e nenhum branch sobrando no repositorio da pessoa.
    expect(g('worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(g('branch', '--list', 'hive/*').trim()).toBe('');
    expect(g('status', '--porcelain').trim()).toBe('');
  });
});

/**
 * O caminho que esta etapa existe para cobrir. Os dois agentes escrevem coisas
 * diferentes na mesma linha, e as copias saem do mesmo ponto de partida.
 */
describe('dois agentes no mesmo arquivo', () => {
  const colisao = { alfa: 'o alfa escreveu', beta: 'o beta escreveu' };

  const duasTarefas = [
    { goal: 'primeira', role: 'alfa' as const },
    { goal: 'segunda', role: 'beta' as const },
  ];

  it('detecta, para e pergunta em vez de resolver sozinho', async () => {
    const supervisor = build(colisao);
    const runId = await supervisor.start({ projectPath: repo, tasks: duasTarefas });
    const todos = await drain(supervisor, runId, 'parar');

    const conflito = todos.find((event) => event.type === 'worktree.conflict');
    if (conflito?.type !== 'worktree.conflict') throw new Error('esperava o conflito');
    expect(conflito.payload.files).toEqual([ARQUIVO]);

    const pergunta = todos.find((event) => event.type === 'human.question_raised');
    if (pergunta?.type !== 'human.question_raised') throw new Error('esperava a pergunta');
    expect(pergunta.payload.cause).toBe('merge_conflict');
    // Respondivel por quem nao le codigo: nada de branch, merge ou exit code.
    expect(pergunta.payload.question).not.toMatch(/merge|branch|git|conflict/i);
  });

  it('parar devolve o projeto ao estado anterior, sem marcador nenhum', async () => {
    const supervisor = build(colisao);
    const runId = await supervisor.start({ projectPath: repo, tasks: duasTarefas });
    await drain(supervisor, runId, 'parar');

    const conteudo = readFileSync(join(repo, ARQUIVO), 'utf8');
    expect(conteudo).not.toContain('<<<<<<<');
    // O primeiro trabalho entrou; o segundo ficou de fora e nada quebrou.
    expect(conteudo).toContain('o alfa escreveu');
    expect(g('status', '--porcelain').trim()).toBe('');
    expect(g('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('recusa fechar quando o agente diz que juntou e nao juntou', async () => {
    // O "resolvedor" falso diz que terminou sem tocar nos marcadores.
    const supervisor = build({ ...colisao, gerente: '' });
    const runId = await supervisor.start({ projectPath: repo, tasks: duasTarefas });
    const todos = await drain(supervisor, runId, 'resolver');

    const falhou = todos.find((event) => event.type === 'run.failed');
    if (falhou?.type !== 'run.failed') throw new Error('esperava a execucao falhar');
    expect(falhou.payload.reason).toContain('pela metade');

    // Nenhum agente aprova o proprio trabalho: nada entrou, e o projeto ficou limpo.
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).not.toContain('<<<<<<<');
    expect(g('status', '--porcelain').trim()).toBe('');
  });
});

/**
 * Um adaptador que tambem planeja: quando o pedido chega em modo somente
 * leitura, e o gerente sendo consultado, e a resposta e o plano em JSON.
 */
class PlanningAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('falso');
  readonly displayName = 'Falso';
  readonly capabilities = {
    streamsJson: true, resumesSession: false, acceptsExtraDirs: false, reportsToolCalls: true,
  };
  readonly ordem: string[] = [];

  constructor(
    private readonly plano: string,
    private readonly porPapel: Record<string, string>,
  ) {}

  probe() {
    return Promise.resolve({ available: true as const, version: '0.0.0', executable: 'falso' });
  }

  start(request: AgentRunRequest): AgentRun {
    if (request.readOnly === true) return new PlanRun(request, this.plano);
    this.ordem.push(String(request.taskId));
    return new FakeRun(request, this.porPapel[request.role] ?? 'nada');
  }
}

/** So devolve o texto do plano; nao toca em arquivo nenhum. */
class PlanRun implements AgentRun {
  readonly agentId;
  readonly outcome: Promise<AgentOutcome>;
  private readonly queue = new AsyncQueue<AnyEventDraft>();

  constructor(request: AgentRunRequest, texto: string) {
    this.agentId = request.agentId;
    this.queue.push(
      draft('agent.usage', {
        agentId: request.agentId,
        model: 'modelo-do-gerente',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 300,
        cacheReadTokens: 400,
        costUsd: 0.05,
      }),
    );
    this.queue.close();
    this.outcome = Promise.resolve({ status: 'completed', summary: texto, turns: 1 });
  }

  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
  answer(): void {}
  cancel(): void {}
}

const PLANO = JSON.stringify({
  subtasks: [
    {
      id: 'segundo-passo',
      title: 'Depois',
      description: 'Mexe depois do primeiro.',
      role: 'beta',
      dependsOn: ['primeiro-passo'],
      inputContracts: ['o-contrato'],
      doneWhen: 'o arquivo tem a linha nova',
      gate: { kind: 'test', command: 'true' },
    },
    {
      id: 'primeiro-passo',
      title: 'Antes',
      description: 'Mexe primeiro.',
      role: 'alfa',
      inputContracts: ['o-contrato'],
      doneWhen: 'o arquivo existe',
      gate: { kind: 'test', command: 'true' },
    },
  ],
  contracts: [
    { id: 'o-contrato', kind: 'types', title: 'Formato do arquivo', body: 'titulo, corpo, rodape' },
  ],
});

function buildPlanning(plano: string, porPapel: Record<string, string>): {
  supervisor: RunSupervisor;
  adapter: PlanningAdapter;
} {
  const adapter = new PlanningAdapter(plano, porPapel);
  return {
    adapter,
    supervisor: new RunSupervisor(
      events,
      createAdapterRegistry([adapter]),
      ROSTER,
      worktrees,
      join(home, 'worktrees'),
    ),
  };
}

describe('execucao planejada', () => {
  it('pergunta antes de comecar e nao mexe em nada se a pessoa cancelar', async () => {
    const { supervisor } = buildPlanning(PLANO, { alfa: 'linha dois', beta: 'linha dois' });
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'fazer o login' });
    const todos = await drain(supervisor, runId, 'parar');

    const pergunta = todos.find((event) => event.type === 'human.question_raised');
    expect(pergunta?.payload).toMatchObject({ cause: 'plan_review' });
    // Cancelar antes de aprovar nao pode ter criado copia nenhuma no disco.
    expect(typesOf(todos)).not.toContain('worktree.created');
    expect(g('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('roda as subtasks em ordem de dependencia, nao na ordem do plano', async () => {
    const { supervisor, adapter } = buildPlanning(PLANO, { alfa: 'linha dois', beta: 'linha dois' });
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'fazer o login' });
    const todos = await drain(supervisor, runId, 'comecar');

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    // O plano lista o dependente primeiro; quem manda e o grafo.
    expect(adapter.ordem).toEqual(['primeiro-passo', 'segundo-passo']);
  });

  it('publica o contrato antes da subtask que depende dele', async () => {
    const { supervisor } = buildPlanning(PLANO, { alfa: 'linha dois', beta: 'linha dois' });
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'fazer o login' });
    const todos = await drain(supervisor, runId, 'comecar');

    const tipos = typesOf(todos);
    // Contrato antes de paralelismo: publicado uma vez so, e antes do trabalho.
    expect(tipos.filter((type) => type === 'contract.published')).toHaveLength(1);
    expect(tipos.indexOf('contract.published')).toBeLessThan(tipos.indexOf('task.assigned'));
  });

  it('gerente que nao consegue dividir encerra perguntando, sem criar copia', async () => {
    const { supervisor } = buildPlanning('nao entendi o que voce quer', {});
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'faz ai' });
    const todos = await drain(supervisor, runId, null);

    expect(typesOf(todos).at(-1)).toBe('run.failed');
    expect(typesOf(todos)).not.toContain('worktree.created');
    expect(g('status', '--porcelain').trim()).toBe('');
  });
});

/**
 * Um agente roteirizado: cada chamada consome um passo. E o que permite
 * escrever "entrega quebrado, depois consertado" e "pergunta, depois entrega"
 * sem inventar comportamento no meio.
 */
type Passo =
  /** Termina dizendo que fez, deixando este texto no arquivo. */
  | { readonly entrega: string; readonly arquivo?: string }
  /** Para e pergunta. So volta a andar quando alguem responder. */
  | { readonly pergunta: string }
  /** Cai antes de terminar. */
  | { readonly cai: string }
  /** Repete a mesma acao N vezes, deixa este texto no arquivo, e diz que terminou. */
  | {
      readonly insiste: {
        readonly alvo: string;
        readonly vezes: number;
        readonly escreve?: string;
      };
    };

class RoteiroRun implements AgentRun {
  readonly agentId;
  readonly outcome: Promise<AgentOutcome>;
  private readonly queue = new AsyncQueue<AnyEventDraft>();

  constructor(request: AgentRunRequest, passo: Passo, sessao: string) {
    this.agentId = request.agentId;

    this.queue.push(
      draft('agent.spawned', {
        agentId: request.agentId, role: request.role, displayName: 'Roteiro',
        adapter: adapterId.parse('falso'), worktreePath: request.cwd,
      }),
      draft('agent.usage', {
        agentId: request.agentId,
        model: 'modelo-de-teste',
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 30,
        cacheReadTokens: 67,
        costUsd: 0.01,
      }),
    );

    if ('insiste' in passo) {
      if (passo.insiste.escreve !== undefined) {
        writeFileSync(join(request.cwd, ARQUIVO), `titulo\n${passo.insiste.escreve}\nrodape\n`);
      }
      for (let vez = 0; vez < passo.insiste.vezes; vez += 1) {
        this.queue.push(
          draft('tool.call', {
            agentId: request.agentId,
            callId: `call_${sessao}_${vez}`,
            tool: 'Bash',
            target: passo.insiste.alvo,
            summary: `Rodando ${passo.insiste.alvo}`,
          }),
        );
      }
      this.outcome = Promise.resolve({
        status: 'completed', summary: 'terminei', turns: passo.insiste.vezes, sessionId: sessao,
      });
    } else if ('entrega' in passo) {
      writeFileSync(
        join(request.cwd, passo.arquivo ?? ARQUIVO),
        `titulo\n${passo.entrega}\nrodape\n`,
      );
      this.outcome = Promise.resolve({
        status: 'completed', summary: 'terminei', turns: 1, sessionId: sessao,
      });
    } else if ('pergunta' in passo) {
      this.outcome = Promise.resolve({
        status: 'blocked',
        questionId: questionId.parse(`qst_${sessao}`),
        question: passo.pergunta,
        sessionId: sessao,
      });
    } else {
      this.outcome = Promise.resolve({ status: 'failed', reason: passo.cai });
    }

    this.queue.push(draft('agent.despawned', { agentId: request.agentId, reason: 'finished' }));
    this.queue.close();
  }

  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
  answer(): void {}
  cancel(): void {}
}

class RoteiroAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('falso');
  readonly displayName = 'Roteiro';
  readonly capabilities = {
    streamsJson: true, resumesSession: true, acceptsExtraDirs: false, reportsToolCalls: true,
  };
  /** O que cada tentativa recebeu. E como se confere que a conversa foi retomada. */
  readonly recebidos: {
    sessionId: string | undefined;
    prompt: string;
    turnos: number;
    model: string | undefined;
  }[] = [];
  private passo = 0;

  constructor(
    private readonly plano: string,
    private readonly roteiro: readonly Passo[],
  ) {}

  probe() {
    return Promise.resolve({ available: true as const, version: '0.0.0', executable: 'falso' });
  }

  start(request: AgentRunRequest): AgentRun {
    if (request.readOnly === true) return new PlanRun(request, this.plano);

    this.recebidos.push({
      sessionId: request.sessionId,
      prompt: request.prompt,
      turnos: request.budget.maxTurns,
      model: request.model,
    });
    const passo = this.roteiro[Math.min(this.passo, this.roteiro.length - 1)] ?? { entrega: 'nada' };
    this.passo += 1;
    return new RoteiroRun(request, passo, `sessao-${this.recebidos.length}`);
  }
}

/**
 * Um plano de um passo so, com portao que da para reprovar de proposito: passa
 * quando o arquivo entregue tem a palavra combinada, e reprova quando nao tem.
 */
const planoComPortao = (comando: string): string =>
  JSON.stringify({
    subtasks: [
      {
        id: 'o-passo',
        title: 'O passo',
        description: 'Mexe no arquivo.',
        role: 'alfa',
        doneWhen: 'o arquivo tem a palavra combinada',
        gate: { kind: 'test', command: comando },
      },
    ],
    contracts: [],
  });

function buildRoteiro(
  plano: string,
  roteiro: readonly Passo[],
): { supervisor: RunSupervisor; adapter: RoteiroAdapter } {
  const adapter = new RoteiroAdapter(plano, roteiro);
  return {
    adapter,
    supervisor: new RunSupervisor(
      events,
      createAdapterRegistry([adapter]),
      ROSTER,
      worktrees,
      join(home, 'worktrees'),
      new CommandGateRunner(),
      undefined,
      undefined,
      // O repositorio de teste nao tem dependencia nenhuma; desligar deixa isso
      // explicito em vez de depender de o `package.json` nao existir.
      new InstallWorktreePreparer({ install: false }),
    ),
  };
}

const PORTAO = `grep -q PRONTO ${ARQUIVO} || { echo "${ARQUIVO} nao tem a palavra combinada" >&2; exit 1; }`;

/**
 * Nenhum agente aprova o proprio trabalho. Aqui o agente diz "terminei" e o
 * portao discorda -- e e o portao que decide.
 */
describe('agente que entrega codigo quebrado', () => {
  it('roda o portao na copia e reprova quem disse que terminou', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [{ entrega: 'quebrado' }]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    const iniciados = payloadsOf(todos, 'gate.started');
    expect(iniciados[0]?.command).toBe(PORTAO);

    const reprovado = payloadsOf(todos, 'gate.failed')[0];
    expect(reprovado?.exitCode).toBe(1);
    // Frase na frente, saida bruta atras de um clique.
    expect(reprovado?.summary).not.toMatch(/grep|exit|stderr/i);
    expect(reprovado?.detail).toBeTypeOf('string');
  });

  it('pede uma correcao antes de incomodar a pessoa, e so pergunta na segunda', async () => {
    const { supervisor, adapter } = buildRoteiro(planoComPortao(PORTAO), [{ entrega: 'quebrado' }]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    // Duas tentativas: a primeira falha vira pedido de correcao, a segunda sobe.
    expect(payloadsOf(todos, 'gate.failed')).toHaveLength(2);
    expect(adapter.recebidos).toHaveLength(2);
    // A saida do portao vai colada no pedido: e isso que o agente conserta.
    expect(adapter.recebidos[1]?.prompt).toContain(PORTAO);
    expect(adapter.recebidos[1]?.prompt).toMatch(/nao apague nem desative/i);
    // E a conversa e a mesma, nao um agente novo sem contexto.
    expect(adapter.recebidos[1]?.sessionId).toBe('sessao-1');

    const perguntas = payloadsOf(todos, 'human.question_raised');
    expect(perguntas.map((pergunta) => pergunta.cause)).toEqual(['plan_review', 'gate_failed']);
    expect(perguntas[1]?.question).not.toMatch(/grep|exit|gate|portao/i);
  });

  it('trabalho reprovado nao entra no projeto', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [{ entrega: 'quebrado' }]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    expect(typesOf(todos).at(-1)).toBe('run.failed');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).not.toContain('quebrado');
    expect(typesOf(todos)).not.toContain('worktree.merged');

    // A subtask fecha como falha em vez de ficar "sendo verificada" para
    // sempre, e a saida do portao vai junto, separada da frase.
    const falhou = payloadsOf(todos, 'task.failed')[0];
    expect(falhou?.reason).not.toMatch(/grep|exit/i);
    expect(falhou?.detail).toContain('login.txt');
    // E nada sobrou no disco de quem esta usando o projeto.
    expect(g('status', '--porcelain').trim()).toBe('');
    expect(g('worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(g('branch', '--list', 'hive/*').trim()).toBe('');
  });

  it('portao verde na segunda tentativa integra normalmente', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [
      { entrega: 'quebrado' },
      { entrega: 'PRONTO' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    expect(payloadsOf(todos, 'gate.failed')).toHaveLength(1);
    // Duas verdes: a da subtask e a do projeto inteiro depois de integrar.
    expect(payloadsOf(todos, 'gate.passed')).toHaveLength(2);
    expect(typesOf(todos).at(-1)).toBe('run.completed');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).toContain('PRONTO');
    // Uma correcao automatica nao vira pergunta: a pessoa so aprovou o plano.
    expect(payloadsOf(todos, 'human.question_raised')).toHaveLength(1);
  });

  it('a pessoa pode mandar tentar de novo, e o que ela escreve vira instrucao', async () => {
    const { supervisor, adapter } = buildRoteiro(planoComPortao(PORTAO), [
      { entrega: 'quebrado' },
      { entrega: 'quebrado' },
      { entrega: 'PRONTO' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, [
      'comecar',
      'a palavra tem que estar em maiuscula',
    ]);

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    expect(adapter.recebidos).toHaveLength(3);
    expect(adapter.recebidos[2]?.prompt).toContain('a palavra tem que estar em maiuscula');
  });
});

/**
 * Escalonamento e a experiencia principal, nao um caminho de erro: o agente
 * que nao sabe o que a pessoa quer pergunta, e a execucao continua depois da
 * resposta -- nao recomeca, e nao adivinha.
 */
describe('task deliberadamente ambigua', () => {
  const AMBIGUA = 'O botao de entrar deve levar para a lista ou para o painel?';

  it('para e pergunta em vez de escolher sozinho', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [
      { pergunta: AMBIGUA },
      { entrega: 'PRONTO para o painel' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'deixar melhor' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'o painel']);

    const perguntas = payloadsOf(todos, 'human.question_raised');
    expect(perguntas.map((pergunta) => pergunta.cause)).toEqual(['plan_review', 'agent_asked']);
    // A duvida sobe como o agente escreveu: quem sabe o que falta e ele.
    expect(perguntas[1]?.question).toBe(AMBIGUA);
    expect(perguntas[1]?.allowFreeText).toBe(true);
    expect(perguntas[1]?.options).toEqual([]);
  });

  it('retoma a mesma conversa com a resposta, sem recomecar do zero', async () => {
    const { supervisor, adapter } = buildRoteiro(planoComPortao(PORTAO), [
      { pergunta: AMBIGUA },
      { entrega: 'PRONTO para o painel' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'deixar melhor' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'o painel']);

    expect(adapter.recebidos).toHaveLength(2);
    expect(adapter.recebidos[1]?.sessionId).toBe('sessao-1');
    expect(adapter.recebidos[1]?.prompt).toContain('o painel');

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).toContain('PRONTO para o painel');
  });

  it('nada foi mexido enquanto a pergunta estava aberta', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [{ pergunta: AMBIGUA }]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'deixar melhor' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    expect(typesOf(todos).at(-1)).toBe('run.failed');
    expect(typesOf(todos)).not.toContain('worktree.merged');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).toBe('titulo\nlinha dois\nrodape\n');
    expect(g('status', '--porcelain').trim()).toBe('');
  });
});

describe('agente que cai', () => {
  it('tenta de novo uma vez antes de subir a duvida', async () => {
    const { supervisor, adapter } = buildRoteiro(planoComPortao(PORTAO), [
      { cai: 'A CLI encerrou sem terminar o trabalho.' },
      { entrega: 'PRONTO' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    expect(adapter.recebidos).toHaveLength(2);
    expect(typesOf(todos).at(-1)).toBe('run.completed');
    // Queda passageira nao incomoda ninguem: so o aval do plano foi perguntado.
    expect(payloadsOf(todos, 'human.question_raised')).toHaveLength(1);
  });

  it('a segunda queda vira pergunta, com o motivo em linguagem de gente', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [
      { cai: 'A CLI encerrou sem terminar o trabalho.' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    const perguntas = payloadsOf(todos, 'human.question_raised');
    expect(perguntas.at(-1)?.cause).toBe('agent_crashed');
    expect(typesOf(todos).at(-1)).toBe('run.failed');
  });
});

/**
 * Limites duros: estourou o orcamento ou repetiu a mesma coisa, para e
 * pergunta -- nunca segue tentando as cegas.
 */
describe('agente que nao sai do lugar', () => {
  const INSISTINDO: Passo = { insiste: { alvo: 'pnpm test', vezes: 3 } };

  it('detecta a repeticao, corta o agente e pergunta', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [INSISTINDO]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    const laco = payloadsOf(todos, 'loop.detected')[0];
    expect(laco?.occurrences).toBe(3);
    expect(laco?.signature).toBe('Bash:pnpm test');

    const pergunta = payloadsOf(todos, 'human.question_raised').at(-1);
    expect(pergunta?.cause).toBe('budget');
    // A assinatura da ferramenta fica no log, nao na frase que a pessoa le.
    expect(pergunta?.context).not.toContain('Bash:');
    expect(pergunta?.question).not.toMatch(/loop|budget|signature/i);

    expect(typesOf(todos).at(-1)).toBe('run.failed');
    expect(typesOf(todos)).not.toContain('worktree.merged');
  });

  it('parou por repeticao nao vira entrega: o portao nem chegou a rodar', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [INSISTINDO]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    expect(typesOf(todos)).not.toContain('gate.started');
    expect(g('status', '--porcelain').trim()).toBe('');
  });

  it('a pessoa pode mandar continuar, e ai o teto volta a valer do zero', async () => {
    const { supervisor, adapter } = buildRoteiro(planoComPortao(PORTAO), [
      INSISTINDO,
      { entrega: 'PRONTO' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'tentar']);

    expect(adapter.recebidos).toHaveLength(2);
    // Teto renovado: sem isso ela autorizaria uma tentativa que ja nasce sem
    // orcamento e para de novo no primeiro passo.
    expect(adapter.recebidos[1]?.turnos).toBe(adapter.recebidos[0]?.turnos);
    expect(typesOf(todos).at(-1)).toBe('run.completed');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).toContain('PRONTO');
  });
});

/**
 * O teto vale pela subtask inteira, nao por tentativa. Senao "trinta turnos"
 * viraria trinta por tentativa, e o limite deixaria de ser limite.
 */
describe('orcamento atravessa as tentativas', () => {
  it('a correcao automatica recomeca com o que sobrou, nao com o teto cheio', async () => {
    const { supervisor, adapter } = buildRoteiro(planoComPortao(PORTAO), [
      { insiste: { alvo: 'ler o arquivo', vezes: 2, escreve: 'quebrado' } },
      { entrega: 'PRONTO' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    const [primeira, segunda] = adapter.recebidos;
    expect(segunda?.turnos).toBe((primeira?.turnos ?? 0) - 2);
  });
});

/**
 * A fila que a pessoa monta na mao nao passa por plano e por isso nao traz
 * portao declarado. Sem o portao do proprio projeto, este seria o unico
 * caminho do sistema em que "terminei" e aceito sem ninguem conferir.
 */
describe('portao na fila montada a mao', () => {
  const comProjeto = (comando: string): void => {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'projeto', scripts: { typecheck: comando } }, null, 2),
    );
    g('add', '-A');
    g('commit', '-m', 'projeto com verificacao');
  };

  function buildComPortao(
    porPapel: Record<string, string>,
    prep: InstallWorktreePreparer,
  ): RunSupervisor {
    return new RunSupervisor(
      events,
      createAdapterRegistry([new FakeAdapter(porPapel)]),
      ROSTER,
      worktrees,
      join(home, 'worktrees'),
      new CommandGateRunner(),
      undefined,
      undefined,
      prep,
    );
  }

  it('descobre o comando do projeto e reprova entrega que nao passa nele', async () => {
    comProjeto(`grep -q PRONTO ${ARQUIVO}`);
    const supervisor = buildComPortao(
      { alfa: 'quebrado' },
      new InstallWorktreePreparer({ install: false }),
    );

    const runId = await supervisor.start({
      projectPath: repo,
      tasks: [{ goal: 'mexer no login', role: 'alfa' }],
    });
    const todos = await drainAnswering(supervisor, runId, ['parar']);

    const iniciado = payloadsOf(todos, 'gate.started')[0];
    // `npm run` porque o repositorio de teste nao tem lockfile nenhum.
    expect(iniciado?.command).toBe('npm run typecheck');
    expect(iniciado?.kind).toBe('typecheck');
    expect(typesOf(todos).at(-1)).toBe('run.failed');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).not.toContain('quebrado');
  });

  /**
   * Nao ter conseguido conferir nao e o mesmo que reprovar. O agente nao errou
   * nada, entao nao ha o que ele corrija -- e integrar sem ter verificado seria
   * pior que parar.
   */
  it('copia que nao ficou pronta para ser conferida para a execucao sem culpar o agente', async () => {
    comProjeto('true');
    // Um instalador que sempre falha, na frente do PATH.
    const fingido = join(home, 'bin');
    execFileSync('mkdir', ['-p', fingido]);
    writeFileSync(join(fingido, 'npm'), '#!/bin/sh\necho "ENOENT: rede fora" >&2\nexit 1\n');
    execFileSync('chmod', ['+x', join(fingido, 'npm')]);

    const supervisor = buildComPortao(
      { alfa: 'qualquer coisa' },
      new InstallWorktreePreparer({ env: { PATH: `${fingido}:${process.env['PATH'] ?? ''}` } }),
    );
    const runId = await supervisor.start({
      projectPath: repo,
      tasks: [{ goal: 'mexer no login', role: 'alfa' }],
    });
    const todos = await drainAnswering(supervisor, runId, []);

    const falhou = payloadsOf(todos, 'run.failed')[0];
    expect(falhou?.reason).toContain('preferi nao integrar nada');
    expect(falhou?.reason).not.toMatch(/npm|ENOENT|install/i);
    // Nao virou pedido de correcao: nao ha o que o agente conserte aqui.
    expect(typesOf(todos)).not.toContain('human.question_raised');
    expect(typesOf(todos)).not.toContain('worktree.merged');
    expect(g('status', '--porcelain').trim()).toBe('');
  });
});

/**
 * Nao da para otimizar o que nao se ve. O total precisa fechar com o log, e
 * precisa incluir o gerente: planejar e uma execucao de CLI como outra
 * qualquer, e deixa-la de fora faria o numero mentir para menos justamente no
 * passo que roda sempre.
 */
describe('quanto a execucao custou', () => {
  const somaDoLog = (todos: ReturnType<EventStore['read']>): number =>
    payloadsOf(todos, 'agent.usage').reduce((total, uso) => total + uso.costUsd, 0);

  it('fecha a execucao com o total, e ele bate com a soma do log', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [{ entrega: 'PRONTO' }]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    const fim = payloadsOf(todos, 'run.completed')[0];
    expect(fim?.costUsd).toBeCloseTo(somaDoLog(todos), 6);
    // Gerente (0,05) + o agente que entregou (0,01).
    expect(fim?.costUsd).toBeCloseTo(0.06, 6);
    expect(fim?.totalTokens).toBe(730 + 100);
  });

  it('a correcao automatica aparece no total: retry custa de novo', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [
      { entrega: 'quebrado' },
      { entrega: 'PRONTO' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    // Duas tentativas do agente, nao uma: e esse o preco de um portao vermelho.
    expect(payloadsOf(todos, 'agent.usage').filter((uso) => uso.costUsd === 0.01)).toHaveLength(2);
    expect(payloadsOf(todos, 'run.completed')[0]?.costUsd).toBeCloseTo(0.07, 6);
  });
});

/**
 * O desperdicio que mais pesava: cada subtask criava uma copia nova e instalava
 * tudo de novo. Medido no repositorio de verdade, instalar custa 16s e replicar
 * por hardlink custa 0,12s -- e a diferenca entre pagar uma vez e pagar N.
 */
describe('preparar a copia uma vez por execucao', () => {
  const DOIS_PASSOS = JSON.stringify({
    subtasks: [
      {
        id: 'primeiro',
        title: 'Primeiro',
        description: 'Mexe no arquivo.',
        role: 'alfa',
        doneWhen: 'o arquivo tem a palavra combinada',
        gate: { kind: 'test', command: 'true' },
      },
      {
        id: 'segundo',
        title: 'Segundo',
        description: 'Mexe depois.',
        role: 'alfa',
        dependsOn: ['primeiro'],
        doneWhen: 'o arquivo continua valido',
        gate: { kind: 'test', command: 'true' },
      },
    ],
    contracts: [],
  });

  it('instala na primeira copia e replica nas seguintes', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', scripts: { t: 'x' } }));
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    g('add', '-A');
    g('commit', '-m', 'projeto com dependencia');

    // Um instalador falso que anota cada chamada e deixa algo para replicar.
    const bin = join(home, 'bin');
    const marca = join(home, 'instalacoes.txt');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\necho chamou >> ${marca}\nmkdir -p node_modules/zod\necho ok > node_modules/zod/index.js\n`,
    );
    execFileSync('chmod', ['+x', join(bin, 'pnpm')]);

    const adapter = new RoteiroAdapter(DOIS_PASSOS, [{ entrega: 'PRONTO' }]);
    const supervisor = new RunSupervisor(
      events,
      createAdapterRegistry([adapter]),
      ROSTER,
      worktrees,
      join(home, 'worktrees'),
      new CommandGateRunner(),
      undefined,
      undefined,
      new InstallWorktreePreparer({ env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } }),
    );

    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'dois passos' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    expect(typesOf(todos).filter((type) => type === 'worktree.created')).toHaveLength(2);
    // Duas copias, uma instalacao: a segunda saiu da primeira.
    expect(readFileSync(marca, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

/**
 * A quebra que nenhum portao de subtask consegue ver.
 *
 * Cada agente e verificado na propria copia, que saiu do mesmo ponto de
 * partida e nao conhece o trabalho dos outros. Dois passos podem passar
 * sozinhos e quebrar quando juntam -- e isso so aparece rodando a verificacao
 * no projeto inteiro depois de integrar.
 */
describe('o projeto inteiro depois de integrar', () => {
  // Passa com ate um arquivo de marca; com dois, reprova.
  const CONTA = 'test "$(ls marca-*.txt 2>/dev/null | wc -l)" -lt 2';

  const DOIS_QUE_COLIDEM = JSON.stringify({
    subtasks: [
      {
        id: 'passo-a',
        title: 'A',
        description: 'Cria a marca A.',
        role: 'alfa',
        doneWhen: 'a marca A existe',
        gate: { kind: 'test', command: CONTA },
      },
      {
        id: 'passo-b',
        title: 'B',
        description: 'Cria a marca B.',
        role: 'alfa',
        dependsOn: ['passo-a'],
        doneWhen: 'a marca B existe',
        gate: { kind: 'test', command: CONTA },
      },
    ],
    contracts: [],
  });

  it('reprova o conjunto mesmo com todos os passos verdes', async () => {
    const { supervisor } = buildRoteiro(DOIS_QUE_COLIDEM, [
      { entrega: 'a', arquivo: 'marca-a.txt' },
      { entrega: 'b', arquivo: 'marca-b.txt' },
    ]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'dois passos' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    // Os dois passos passaram sozinhos -- cada copia so tinha a marca dele.
    expect(payloadsOf(todos, 'gate.passed')).toHaveLength(2);
    // E o conjunto nao passa.
    expect(payloadsOf(todos, 'gate.failed')).toHaveLength(1);

    const falhou = payloadsOf(todos, 'run.failed')[0];
    expect(falhou?.reason).toContain('nao passa com tudo junto');
    // O trabalho ja esta no projeto, e a frase precisa dizer isso: e o que a
    // pessoa precisa saber para decidir se desfaz ou se conserta.
    expect(falhou?.reason).toContain('ja esta no seu projeto');
    expect(readFileSync(join(repo, 'marca-a.txt'), 'utf8')).toContain('a');
    expect(readFileSync(join(repo, 'marca-b.txt'), 'utf8')).toContain('b');
  });

  it('nao roda a verificacao final quando a execucao parou antes de entregar', async () => {
    const { supervisor } = buildRoteiro(planoComPortao(PORTAO), [{ entrega: 'quebrado' }]);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'arrumar o login' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    // Duas do portao da subtask, e nenhuma do conjunto: nada foi integrado.
    expect(payloadsOf(todos, 'gate.started')).toHaveLength(2);
  });
});

/**
 * O sistema recomenda, a pessoa decide. A escolha entra no aval do plano, que
 * ja e uma parada obrigatoria -- uma pergunta so para escolher modelo seria
 * uma interrupcao a mais por uma decisao que cabe nesta.
 */
describe('qual modelo cada passo usa', () => {
  const COM_ESCADA = rosterSchema.parse([
    { id: 'gerente', title: 'Gerente', adapter: 'falso', canDelegate: true, description: 'Integra.',
      models: { economico: 'barato', padrao: 'medio', caprichado: 'caro' } },
    { id: 'alfa', title: 'Alfa', adapter: 'falso', canDelegate: false, description: 'Um.',
      models: { economico: 'barato', padrao: 'medio', caprichado: 'caro' } },
    { id: 'beta', title: 'Beta', adapter: 'falso', canDelegate: false, description: 'Sem escada.' },
  ]);

  function buildComEscada(plano: string, papel: 'alfa' | 'beta' = 'alfa'): {
    supervisor: RunSupervisor;
    adapter: RoteiroAdapter;
  } {
    const adapter = new RoteiroAdapter(plano, [{ entrega: 'PRONTO' }]);
    void papel;
    return {
      adapter,
      supervisor: new RunSupervisor(
        events,
        createAdapterRegistry([adapter]),
        COM_ESCADA,
        worktrees,
        join(home, 'worktrees'),
        new CommandGateRunner(),
        undefined,
        undefined,
        new InstallWorktreePreparer({ install: false }),
      ),
    };
  }

  /** Um passo pequeno: uma area so, sem contrato, portao barato. */
  const PASSO_PEQUENO = (role: string): string =>
    JSON.stringify({
      subtasks: [
        {
          id: 'pequeno',
          title: 'Pequeno',
          description: 'Troca um texto.',
          role,
          allowedPaths: ['login.txt'],
          doneWhen: 'o texto mudou',
          gate: { kind: 'lint', command: `grep -q PRONTO ${ARQUIVO}` },
        },
      ],
      contracts: [],
    });

  it('recomenda o economico para passo pequeno, e diz por que', async () => {
    const { supervisor } = buildComEscada(PASSO_PEQUENO('alfa'));
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'trocar um texto' });
    const todos = await drainAnswering(supervisor, runId, ['comecar']);

    const passo = payloadsOf(todos, 'plan.created')[0]?.plan.subtasks[0];
    expect(passo?.modelTier).toBe('economico');
    expect(passo?.modelReason).toBe('mexe numa area so');
  });

  it('"comecar como eu sugeri" usa o degrau recomendado', async () => {
    const { supervisor, adapter } = buildComEscada(PASSO_PEQUENO('alfa'));
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'trocar um texto' });
    await drainAnswering(supervisor, runId, ['comecar']);

    expect(adapter.recebidos[0]?.model).toBe('barato');
  });

  it('"gastando o minimo" nao sai da ponta de baixo da escada', async () => {
    const { supervisor, adapter } = buildComEscada(PASSO_PEQUENO('alfa'));
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'trocar um texto' });
    await drainAnswering(supervisor, runId, ['comecar-economico']);

    expect(adapter.recebidos[0]?.model).toBe('barato');
  });

  it('"caprichando" sobe um degrau em cima da recomendacao', async () => {
    const { supervisor, adapter } = buildComEscada(PASSO_PEQUENO('alfa'));
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'trocar um texto' });
    await drainAnswering(supervisor, runId, ['comecar-caprichado']);

    expect(adapter.recebidos[0]?.model).toBe('medio');
  });

  /**
   * Papel cuja CLI tem aliases que so existem no config do usuario nao pode
   * receber um nome chutado: um modelo desconhecido derruba a execucao inteira.
   */
  it('papel sem escada roda no padrao da CLI, seja qual for a postura', async () => {
    const { supervisor, adapter } = buildComEscada(PASSO_PEQUENO('beta'));
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'trocar um texto' });
    await drainAnswering(supervisor, runId, ['comecar-caprichado']);

    expect(adapter.recebidos[0]?.model).toBeUndefined();
  });

  it('cancelar continua cancelando, e nada foi criado', async () => {
    const { supervisor } = buildComEscada(PASSO_PEQUENO('alfa'));
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'trocar um texto' });
    const todos = await drainAnswering(supervisor, runId, ['parar']);

    expect(typesOf(todos).at(-1)).toBe('run.failed');
    expect(typesOf(todos)).not.toContain('worktree.created');
  });
});

/**
 * A fila manual existe para ser o caminho barato: quem escolhe o proprio papel
 * ja sabe que a tarefa e pequena. Sem escolher o degrau, ela caia no modelo
 * padrao da CLI -- que e o mais caro -- e media, na mesma tarefa, US$ 0,2475
 * contra US$ 0,0479 no economico.
 */
describe('quanto capricho a fila manual pede', () => {
  const COM_ESCADA = rosterSchema.parse([
    { id: 'gerente', title: 'Gerente', adapter: 'falso', canDelegate: true, description: 'Integra.' },
    { id: 'alfa', title: 'Alfa', adapter: 'falso', canDelegate: false, description: 'Um.',
      models: { economico: 'barato', padrao: 'medio', caprichado: 'caro' } },
    { id: 'beta', title: 'Beta', adapter: 'falso', canDelegate: false, description: 'Sem escada.' },
  ]);

  function buildFila(): { supervisor: RunSupervisor; adapter: RoteiroAdapter } {
    const adapter = new RoteiroAdapter('(sem plano)', [{ entrega: 'PRONTO' }]);
    return {
      adapter,
      supervisor: new RunSupervisor(
        events,
        createAdapterRegistry([adapter]),
        COM_ESCADA,
        worktrees,
        join(home, 'worktrees'),
        new CommandGateRunner(),
        undefined,
        undefined,
        new InstallWorktreePreparer({ install: false }),
      ),
    };
  }

  it('sem escolha nenhuma, vai no mais barato', async () => {
    const { supervisor, adapter } = buildFila();
    const runId = await supervisor.start({
      projectPath: repo,
      tasks: [{ goal: 'trocar um texto', role: 'alfa' }],
    });
    await drainAnswering(supervisor, runId, []);

    expect(adapter.recebidos[0]?.model).toBe('barato');
  });

  it('a pessoa pode pedir capricho, e a fila inteira sobe', async () => {
    const { supervisor, adapter } = buildFila();
    const runId = await supervisor.start({
      projectPath: repo,
      tasks: [{ goal: 'trocar um texto', role: 'alfa' }],
      modelTier: 'caprichado',
    });
    await drainAnswering(supervisor, runId, []);

    expect(adapter.recebidos[0]?.model).toBe('caro');
  });

  it('papel sem escada continua no padrao da CLI', async () => {
    const { supervisor, adapter } = buildFila();
    const runId = await supervisor.start({
      projectPath: repo,
      tasks: [{ goal: 'trocar um texto', role: 'beta' }],
      modelTier: 'caprichado',
    });
    await drainAnswering(supervisor, runId, []);

    expect(adapter.recebidos[0]?.model).toBeUndefined();
  });
});

/**
 * Dois especialistas ao mesmo tempo.
 *
 * O agente falso segura a propria execucao ate ser solto, que e o unico jeito
 * de provar sobreposicao: agente que termina na hora nunca se cruza com outro,
 * e o teste passaria mesmo com o executor sequencial de antes.
 */
class Cronometro {
  vivos = 0;
  pico = 0;
  /** Os contratos que cada agente encontrou na propria copia, por papel. */
  readonly contratosVistos: Record<string, string> = {};
}

class ParaleloRun implements AgentRun {
  readonly agentId;
  readonly outcome: Promise<AgentOutcome>;
  private readonly queue = new AsyncQueue<AnyEventDraft>();

  constructor(request: AgentRunRequest, arquivo: string, relogio: Cronometro, seguraMs: number) {
    this.agentId = request.agentId;
    relogio.vivos += 1;
    relogio.pico = Math.max(relogio.pico, relogio.vivos);

    // O contrato tem que estar no disco **antes** de o agente comecar: e essa
    // a diferenca entre combinado publicado e combinado disponivel.
    const contrato = join(request.cwd, CONTRACTS_DIR, 'o-contrato.md');
    relogio.contratosVistos[request.role] = existsSync(contrato)
      ? readFileSync(contrato, 'utf8')
      : '';

    // Agente cria pasta quando precisa, como faria de verdade.
    mkdirSync(dirname(join(request.cwd, arquivo)), { recursive: true });
    writeFileSync(join(request.cwd, arquivo), `escrito por ${request.role}\n`);

    this.queue.push(
      draft('agent.spawned', {
        agentId: request.agentId, role: request.role, displayName: 'Paralelo',
        adapter: adapterId.parse('falso'), worktreePath: request.cwd,
      }),
      draft('agent.usage', {
        agentId: request.agentId,
        model: 'modelo-de-teste',
        inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4,
        costUsd: 0.02,
      }),
    );

    this.outcome = new Promise<AgentOutcome>((resolve) => {
      setTimeout(() => {
        relogio.vivos -= 1;
        this.queue.push(draft('agent.despawned', { agentId: request.agentId, reason: 'finished' }));
        this.queue.close();
        resolve({ status: 'completed', summary: 'pronto', turns: 1 });
      }, seguraMs);
    });
  }

  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
  answer(): void {}
  cancel(): void {}
}

class ParaleloAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('falso');
  readonly displayName = 'Paralelo';
  readonly capabilities = {
    streamsJson: true, resumesSession: false, acceptsExtraDirs: false, reportsToolCalls: true,
  };
  readonly relogio = new Cronometro();

  constructor(
    private readonly plano: string,
    private readonly arquivoPorPapel: Record<string, string>,
    private readonly seguraMs = 120,
  ) {}

  probe() {
    return Promise.resolve({ available: true as const, version: '0.0.0', executable: 'falso' });
  }

  start(request: AgentRunRequest): AgentRun {
    if (request.readOnly === true) return new PlanRun(request, this.plano);
    return new ParaleloRun(
      request,
      this.arquivoPorPapel[request.role] ?? ARQUIVO,
      this.relogio,
      this.seguraMs,
    );
  }
}

/** Dois passos sem dependencia entre si, cada um na sua area, com um contrato comum. */
const planoParalelo = (paths: { alfa: string[]; beta: string[] }): string =>
  JSON.stringify({
    subtasks: [
      {
        id: 'lado-alfa',
        title: 'Um lado',
        description: 'Mexe de um lado.',
        role: 'alfa',
        allowedPaths: paths.alfa,
        inputContracts: ['o-contrato'],
        doneWhen: 'o arquivo de um lado existe',
        gate: { kind: 'test', command: 'true' },
      },
      {
        id: 'lado-beta',
        title: 'Outro lado',
        description: 'Mexe do outro lado.',
        role: 'beta',
        allowedPaths: paths.beta,
        inputContracts: ['o-contrato'],
        doneWhen: 'o arquivo do outro lado existe',
        gate: { kind: 'test', command: 'true' },
      },
    ],
    contracts: [
      {
        id: 'o-contrato',
        kind: 'types',
        title: 'Formato do arquivo',
        body: 'uma linha dizendo quem escreveu',
      },
    ],
  });

function buildParalelo(plano: string, arquivos: Record<string, string>): {
  supervisor: RunSupervisor;
  adapter: ParaleloAdapter;
} {
  const adapter = new ParaleloAdapter(plano, arquivos);
  return {
    adapter,
    supervisor: new RunSupervisor(
      events,
      createAdapterRegistry([adapter]),
      ROSTER,
      worktrees,
      join(home, 'worktrees'),
    ),
  };
}

describe('dois especialistas ao mesmo tempo', () => {
  const areasSeparadas = planoParalelo({ alfa: ['um'], beta: ['dois'] });
  const arquivos = { alfa: 'um/dele.txt', beta: 'dois/dela.txt' };

  beforeEach(() => {
    execFileSync('mkdir', ['-p', join(repo, 'um'), join(repo, 'dois')]);
    writeFileSync(join(repo, 'um', 'base.txt'), 'base\n');
    writeFileSync(join(repo, 'dois', 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-m', 'areas');
  });

  it('roda os dois passos ao mesmo tempo quando as areas nao se encostam', async () => {
    const { supervisor, adapter } = buildParalelo(areasSeparadas, arquivos);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    const todos = await drain(supervisor, runId, 'comecar');

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    // O que prova paralelismo: os dois estiveram no ar ao mesmo tempo.
    expect(adapter.relogio.pico).toBe(2);
  });

  /**
   * Contrato antes de paralelismo. Nao basta o evento sair antes: o arquivo tem
   * que estar na copia dos **dois** quando cada um comeca, senao o segundo
   * especialista descobre o combinado tarde demais para obedece-lo.
   */
  it('os dois encontram o contrato na propria copia antes de comecar', async () => {
    const { supervisor, adapter } = buildParalelo(areasSeparadas, arquivos);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    const todos = await drain(supervisor, runId, 'comecar');

    expect(adapter.relogio.contratosVistos['alfa']).toContain('uma linha dizendo quem escreveu');
    expect(adapter.relogio.contratosVistos['beta']).toContain('uma linha dizendo quem escreveu');

    const tipos = typesOf(todos);
    expect(tipos.filter((type) => type === 'contract.published')).toHaveLength(1);
    // Publicado antes do **lote**, e nao antes de cada um: quando o primeiro
    // agente recebe a tarefa, o combinado ja existe para os dois.
    expect(tipos.indexOf('contract.published')).toBeLessThan(tipos.indexOf('task.assigned'));
  });

  /** Andaime do app nao vira commit no projeto de quem so pediu uma tarefa. */
  it('o contrato nao entra no projeto da pessoa', async () => {
    const { supervisor } = buildParalelo(areasSeparadas, arquivos);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    await drain(supervisor, runId, 'comecar');

    expect(existsSync(join(repo, '.hive'))).toBe(false);
    expect(g('log', '--name-only', '--pretty=format:')).not.toContain('.hive');
    expect(g('status', '--porcelain').trim()).toBe('');
  });

  it('mede o que correr junto economizou, e diz se compensou', async () => {
    const { supervisor } = buildParalelo(areasSeparadas, arquivos);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    const todos = await drain(supervisor, runId, 'comecar');

    const medida = payloadsOf(todos, 'plan.measured')[0];
    if (medida === undefined) throw new Error('esperava a medida');

    expect(medida.peakParallel).toBe(2);
    expect(medida.conflicts).toBe(0);
    // Sobreposicao de verdade: a soma dos passos passou do relogio de parede.
    expect(medida.sequentialMs).toBeGreaterThan(medida.wallMs);
    expect(parallelismGain(medida).worthIt).toBe(true);
  });

  /**
   * O caso que o paralelismo existe para nao piorar. Liberados pelo grafo, mas
   * mexendo na mesma pasta: correr junto so adiantaria o conflito de merge.
   */
  it('poe na fila quem mexe na mesma area, mesmo sem dependencia', async () => {
    const mesmaArea = planoParalelo({ alfa: ['um'], beta: ['um/mais/fundo'] });
    const { supervisor, adapter } = buildParalelo(mesmaArea, {
      alfa: 'um/dele.txt',
      beta: 'um/mais/fundo/dela.txt',
    });
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    const todos = await drain(supervisor, runId, 'comecar');

    expect(typesOf(todos).at(-1)).toBe('run.completed');
    expect(adapter.relogio.pico).toBe(1);

    const medida = payloadsOf(todos, 'plan.measured')[0];
    expect(medida?.peakParallel).toBe(1);
    expect(medida?.heldForOverlap).toBeGreaterThan(0);
  });

  /**
   * O plano jurou que as areas eram separadas e os dois mexeram no mesmo
   * arquivo. E o caso que a medida existe para nomear: quem falhou foi a etapa
   * de contrato, e o numero tem que dizer isso em vez de o sistema culpar a
   * ideia de paralelizar.
   */
  it('colisao apesar das areas separadas conta como custo de juntar', async () => {
    const { supervisor } = buildParalelo(areasSeparadas, { alfa: ARQUIVO, beta: ARQUIVO });
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    const todos = await drainAnswering(supervisor, runId, ['comecar', 'parar']);

    expect(typesOf(todos)).toContain('worktree.conflict');

    const medida = payloadsOf(todos, 'plan.measured')[0];
    if (medida === undefined) throw new Error('esperava a medida mesmo com a execucao parada');

    expect(medida.peakParallel).toBe(2);
    expect(medida.conflicts).toBe(1);
    // Desfazer colisao e parte de juntar, e nunca maior que o total de juntar.
    // O veredito em si depende de quanto tempo a pessoa leva para responder, e
    // por isso e medido onde ele mora (`parallelismGain`), nao aqui.
    expect(medida.conflictMs).toBeGreaterThan(0);
    expect(medida.mergeMs).toBeGreaterThanOrEqual(medida.conflictMs);
    // Ninguem foi chamado para desfazer, entao desfazer nao custou nada -- e o
    // que os dois especialistas gastaram trabalhando nao pode virar custo de
    // colisao so por terem gastado enquanto ela estava aberta.
    expect(medida.conflictCostUsd).toBe(0);
    expect(payloadsOf(todos, 'agent.usage').length).toBeGreaterThan(0);
  });

  /**
   * Uma subtask que estoura no nosso lado nao pode derrubar a outra que esta no
   * ar: com `Promise.race`, uma excecao deixaria a irma trabalhando sozinha,
   * fora do alcance de quem ia limpar as copias.
   */
  it('erro nosso num passo fecha a execucao sem deixar copia solta', async () => {
    const { supervisor, adapter } = buildParalelo(areasSeparadas, arquivos);
    const original = adapter.start.bind(adapter);
    let primeiro = true;
    adapter.start = (request: AgentRunRequest): AgentRun => {
      if (request.readOnly !== true && primeiro) {
        primeiro = false;
        throw new Error('estourou do nosso lado');
      }
      return original(request);
    };

    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    const todos = await drain(supervisor, runId, 'comecar');

    const falhou = todos.find((event) => event.type === 'run.failed');
    if (falhou?.type !== 'run.failed') throw new Error('esperava a execucao falhar');
    // A frase e respondivel por quem nao le codigo; o stack fica atras do clique.
    expect(falhou.payload.reason).not.toContain('Error');

    expect(g('worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(g('branch', '--list', 'hive/*').trim()).toBe('');
    expect(g('status', '--porcelain').trim()).toBe('');
  });

  /** Plano que nao declara area nenhuma nao ganha paralelismo -- e nao aposta. */
  it('sem area declarada continua um de cada vez', async () => {
    const semAreas = planoParalelo({ alfa: [], beta: [] });
    const { supervisor, adapter } = buildParalelo(semAreas, arquivos);
    const runId = await supervisor.startPlanned({ projectPath: repo, goal: 'os dois lados' });
    await drain(supervisor, runId, 'comecar');

    expect(adapter.relogio.pico).toBe(1);
  });
});
