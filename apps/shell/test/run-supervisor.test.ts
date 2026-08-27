import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adapterId,
  draft,
  rosterSchema,
  type AdapterId,
  type AnyEventDraft,
  type RunId,
} from '@office/protocol';
import {
  AsyncQueue,
  GitWorktreeManager,
  createAdapterRegistry,
  type AgentAdapter,
  type AgentOutcome,
  type AgentRun,
  type AgentRunRequest,
} from '@office/agents';
import { EventStore, openDatabase } from '@office/store';
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
  g('config', 'user.email', 'teste@office.local');
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

const typesOf = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

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
    expect(g('branch', '--list', 'office/*').trim()).toBe('');
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
