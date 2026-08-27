import { join } from 'node:path';
import {
  budgetSchema,
  draft,
  newAgentId,
  newQuestionId,
  newTaskId,
  type AdapterId,
  type AgentId,
  type AnyEventDraft,
  type QuestionId,
  type RoleDefinition,
  type RoleId,
  type Roster,
  type RunId,
} from '@office/protocol';
import {
  branchFor,
  GitWorktreeManager,
  type AdapterRegistry,
  type AgentRun,
  type Worktree,
} from '@office/agents';
import type { EventStore } from '@office/store';

/**
 * Conduz uma fila de tarefas com dono, uma de cada vez, cada agente na propria
 * worktree.
 *
 * Mora no shell de proposito: `coordination` nao pode importar de `apps/`, e o
 * gerente -- o que planeja e divide sozinho -- ainda nao existe. Enquanto isso,
 * quem monta a fila e atribui e a propria pessoa.
 */
export interface QueueItem {
  readonly goal: string;
  readonly role: RoleId;
}

export interface StartRunInput {
  readonly projectPath: string;
  readonly tasks: readonly QueueItem[];
}

interface PendingQuestion {
  readonly questionId: QuestionId;
  readonly resolve: (choice: string) => void;
}

interface LiveRun {
  readonly projectPath: string;
  /** Branch onde tudo e integrado. */
  readonly base: string;
  /** Commit de onde toda copia desta execucao sai. Nao anda durante a fila. */
  readonly baseCommit: string;
  readonly startedAt: number;
  /** Worktrees ainda no disco. Existe para nao deixar sobra se algo quebrar. */
  readonly open: Map<AgentId, Worktree>;
  agent: AgentRun | null;
  question: PendingQuestion | null;
  cancelled: boolean;
}

/**
 * O adaptador nunca encerra bloqueado -- se acontecer e bug nosso, e some numa
 * frase generica em vez de virar uma execucao pendurada.
 */
function outcomeReason(outcome: Awaited<AgentRun['outcome']>): string {
  switch (outcome.status) {
    case 'completed':
      return outcome.summary;
    case 'cancelled':
    case 'failed':
      return outcome.reason;
    case 'blocked':
      return 'o agente parou esperando uma resposta que nao chegou.';
  }
}

const RESOLVER = 'resolver';
const STOP = 'parar';

/**
 * A instrucao que vai para a CLI. O enquadramento importa: sem ele o agente
 * chuta quando fica em duvida, e a parada para perguntar -- que e a experiencia
 * principal do produto -- nunca acontece.
 */
function buildPrompt(goal: string): string {
  return [
    goal,
    '',
    'Trabalhe direto nesta pasta. Se ficar em duvida sobre o que a pessoa quer,',
    'pergunte em vez de escolher por conta propria -- quem vai responder nao le',
    'codigo, entao pergunte em linguagem simples.',
  ].join('\n');
}

/**
 * A instrucao de quem vai desfazer o conflito. Ela diz o que **nao** fazer com
 * a mesma clareza que diz o que fazer: escolher um lado em silencio joga fora o
 * trabalho de um dos dois agentes.
 */
function buildMergePrompt(files: readonly string[]): string {
  return [
    'Dois agentes editaram os mesmos arquivos e o git nao conseguiu juntar sozinho.',
    'Um merge esta em curso nesta pasta agora.',
    '',
    'Arquivos com conflito:',
    ...files.map((file) => `- ${file}`),
    '',
    'Abra cada um deles e junte os dois lados preservando a intencao das duas',
    'mudancas. Nao escolha um lado e descarte o outro, e nao deixe nenhum',
    'marcador de conflito (<<<<<<<, =======, >>>>>>>) para tras.',
    'Nao rode nenhum comando git: eu fecho o merge depois de conferir.',
  ].join('\n');
}

export class RunSupervisor {
  private readonly live = new Map<RunId, LiveRun>();

  constructor(
    private readonly events: EventStore,
    private readonly adapters: AdapterRegistry,
    private readonly roster: Roster,
    private readonly worktrees: GitWorktreeManager,
    /** Onde as copias vivem. Fora do repositorio, decidido por quem conhece o SO. */
    private readonly worktreeRoot: string,
  ) {}

  private role(id: RoleId): RoleDefinition {
    const found = this.roster.find((role) => role.id === id);
    if (found === undefined) throw new Error(`o papel "${id}" nao existe no roster`);
    return found;
  }

  /** Quem integra: o papel com autoridade para juntar o trabalho dos outros. */
  private manager(): RoleDefinition {
    const found = this.roster.find((role) => role.canDelegate);
    if (found === undefined) throw new Error('o roster nao tem nenhum papel que possa integrar');
    return found;
  }

  private async adapterFor(id: AdapterId): Promise<ReturnType<AdapterRegistry['get']>> {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) throw new Error(`O adaptador "${id}" nao esta registrado.`);

    // CLI ausente ou sem login e situacao esperada, e vira frase para o usuario
    // -- nunca uma execucao que abre e nunca sai do lugar.
    const probe = await adapter.probe();
    if (!probe.available) throw new Error(probe.reason);
    return adapter;
  }

  async start(input: StartRunInput): Promise<RunId> {
    // Guardas antes de qualquer coisa comecar: sem repositorio nao ha como
    // isolar, e com arvore suja o trabalho da pessoa se misturaria com o deles.
    const check = await this.worktrees.check(input.projectPath);
    if (!check.ok) throw new Error(check.reason);
    await this.worktrees.prune(input.projectPath);

    for (const item of input.tasks) await this.adapterFor(this.role(item.role).adapter);

    const goal = input.tasks.map((item) => item.goal).join(' · ').slice(0, 500);
    const runId = this.events.createRun({ projectPath: input.projectPath, goal });
    this.events.append(runId, {
      type: 'run.started',
      payload: { projectPath: input.projectPath, goal, startedBy: 'human' },
    });

    this.live.set(runId, {
      projectPath: input.projectPath,
      base: check.branch,
      baseCommit: check.commit,
      startedAt: Date.now(),
      open: new Map(),
      agent: null,
      question: null,
      cancelled: false,
    });

    void this.runQueue(runId, input.tasks);
    return runId;
  }

  private emit(runId: RunId, ...events: AnyEventDraft[]): void {
    for (const event of events) this.events.append(runId, event);
  }

  /** Uma de cada vez: a proxima so comeca depois que a anterior foi integrada. */
  private async runQueue(runId: RunId, items: readonly QueueItem[]): Promise<void> {
    const live = this.live.get(runId);
    if (live === undefined) return;

    let done = 0;
    let stopped: string | null = null;
    let detail: string | undefined;

    try {
      for (const item of items) {
        if (live.cancelled) {
          stopped = 'Voce pediu para parar.';
          break;
        }
        const outcome = await this.runOne(runId, live, item);
        if (outcome.status === 'stop') {
          stopped = outcome.reason;
          break;
        }
        done += 1;
      }
    } catch (error) {
      // Falha nossa nao vira frase do usuario: a mensagem tecnica fica em
      // `detail`, atras de um clique, e a frase principal continua respondivel
      // por quem nao le codigo.
      stopped = 'Algo deu errado do meu lado e eu parei antes de mexer no seu projeto.';
      detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error('[run-supervisor] a fila falhou:', error);
    }

    await this.cleanup(runId, live);

    if (stopped === null) {
      this.events.closeRun(
        runId,
        draft('run.completed', {
          summary: `${done} ${done === 1 ? 'tarefa entregue' : 'tarefas entregues'} e integradas ao projeto.`,
          durationMs: Date.now() - live.startedAt,
          tasksCompleted: done,
        }),
        'completed',
      );
    } else {
      this.events.closeRun(
        runId,
        draft('run.failed', {
          reason: stopped,
          ...(detail === undefined ? {} : { detail }),
        }),
        live.cancelled ? 'cancelled' : 'failed',
      );
    }
    this.live.delete(runId);
  }

  private async runOne(
    runId: RunId,
    live: LiveRun,
    item: QueueItem,
  ): Promise<{ readonly status: 'ok' } | { readonly status: 'stop'; readonly reason: string }> {
    const role = this.role(item.role);
    const adapter = await this.adapterFor(role.adapter);
    if (adapter === undefined) return { status: 'stop', reason: 'O adaptador sumiu.' };

    const agentId = newAgentId(role.id);
    const taskId = newTaskId();
    const worktree = await this.worktrees.create({
      agentId,
      repositoryPath: live.projectPath,
      base: live.baseCommit,
      branch: branchFor(agentId),
      path: join(this.worktreeRoot, runId, agentId),
    });
    live.open.set(agentId, worktree);

    this.emit(
      runId,
      draft('worktree.created', {
        agentId, taskId, path: worktree.path, branch: worktree.branch, base: worktree.base,
      }),
      draft('task.assigned', {
        taskId, title: item.goal, role: role.id,
        assignedBy: 'human', assignedTo: agentId, dependsOn: [],
      }),
    );

    const run = adapter.start({
      agentId,
      role: role.id,
      displayName: role.title,
      taskId,
      cwd: worktree.path,
      prompt: buildPrompt(item.goal),
      allowedPaths: [],
      contracts: [],
      budget: budgetSchema.parse({}),
      ...(role.model === undefined ? {} : { model: role.model }),
    });

    const outcome = await this.pump(runId, live, run);

    if (outcome.status !== 'completed') {
      // Trabalho quebrado nao entra no projeto: a copia e descartada inteira.
      await this.discard(runId, live, agentId, worktree);
      return {
        status: 'stop',
        reason:
          outcome.status === 'cancelled'
            ? outcome.reason
            : `Parei em "${item.goal}": ${outcomeReason(outcome)}`,
      };
    }

    const salvou = await this.worktrees.commitAll(worktree, item.goal);
    if (!salvou) {
      await this.discard(runId, live, agentId, worktree);
      return { status: 'ok' };
    }

    return this.integrate(runId, live, { agentId, taskId, worktree, title: item.goal });
  }

  /** Leva os eventos do adaptador para o log, que e a unica fonte da verdade. */
  private async pump(
    runId: RunId,
    live: LiveRun,
    run: AgentRun,
  ): Promise<Awaited<AgentRun['outcome']>> {
    live.agent = run;
    try {
      for await (const event of run) this.events.append(runId, event);
    } catch (error) {
      console.error('[run-supervisor] o stream do agente falhou:', error);
    } finally {
      live.agent = null;
    }
    return run.outcome;
  }

  /**
   * Integrar e etapa explicita, nunca efeito colateral. Conflito para a fila e
   * devolve a decisao para a pessoa -- o sistema nao resolve por conta propria.
   */
  private async integrate(
    runId: RunId,
    live: LiveRun,
    task: { agentId: AgentId; taskId: ReturnType<typeof newTaskId>; worktree: Worktree; title: string },
  ): Promise<{ readonly status: 'ok' } | { readonly status: 'stop'; readonly reason: string }> {
    const { agentId, taskId, worktree } = task;
    const result = await this.worktrees.merge(worktree, live.base);

    if (result.status === 'empty') {
      await this.discard(runId, live, agentId, worktree);
      return { status: 'ok' };
    }

    if (result.status === 'merged') {
      this.emit(
        runId,
        draft('worktree.merged', {
          agentId, taskId, branch: worktree.branch, into: live.base,
          filesChanged: result.filesChanged,
        }),
      );
      await this.remove(runId, live, agentId, worktree, 'merged');
      return { status: 'ok' };
    }

    return this.resolveConflict(runId, live, { agentId, taskId, worktree, files: result.files });
  }

  private async resolveConflict(
    runId: RunId,
    live: LiveRun,
    conflict: {
      agentId: AgentId;
      taskId: ReturnType<typeof newTaskId>;
      worktree: Worktree;
      files: readonly string[];
    },
  ): Promise<{ readonly status: 'ok' } | { readonly status: 'stop'; readonly reason: string }> {
    const { agentId, taskId, worktree, files } = conflict;
    const lista = files.slice(0, 3).join(', ');

    this.emit(
      runId,
      draft('worktree.conflict', {
        agentId, taskId, branch: worktree.branch, into: live.base, files: [...files],
      }),
    );

    const choice = await this.askHuman(runId, live, {
      question: 'Dois agentes mexeram no mesmo lugar. Como quer que eu resolva?',
      context: `Eles editaram ${lista} de formas diferentes, e eu nao sei qual das duas versoes voce quer manter.`,
      cause: 'merge_conflict',
      options: [
        { id: RESOLVER, label: 'Deixar um agente juntar os dois trabalhos' },
        { id: STOP, label: 'Parar por aqui e me mostrar o que aconteceu' },
      ],
      askedBy: agentId,
      taskId,
    });

    if (choice !== RESOLVER) {
      // Desfaz o merge: o repositorio volta exatamente como estava.
      await this.worktrees.abortMerge(live.projectPath);
      await this.discard(runId, live, agentId, worktree);
      return {
        status: 'stop',
        reason: `Parei sem juntar: ${lista} foi editado por dois agentes e a decisao e sua.`,
      };
    }

    const manager = this.manager();
    const adapter = await this.adapterFor(manager.adapter);
    if (adapter === undefined) return { status: 'stop', reason: 'O adaptador sumiu.' };

    const resolverId = newAgentId(manager.id);
    const run = adapter.start({
      agentId: resolverId,
      role: manager.id,
      displayName: manager.title,
      taskId,
      // O merge esta em curso no proprio repositorio: e la que ele precisa mexer.
      cwd: live.projectPath,
      prompt: buildMergePrompt(files),
      allowedPaths: [...files],
      contracts: [],
      budget: budgetSchema.parse({}),
      ...(manager.model === undefined ? {} : { model: manager.model }),
    });

    const outcome = await this.pump(runId, live, run);
    if (outcome.status !== 'completed') {
      await this.worktrees.abortMerge(live.projectPath);
      await this.discard(runId, live, agentId, worktree);
      return { status: 'stop', reason: `Nao consegui juntar os dois trabalhos em ${lista}.` };
    }

    // Nenhum agente aprova o proprio trabalho: antes de fechar, uma checagem
    // objetiva de que nao sobrou marcador de conflito.
    const closed = await this.worktrees.commitMerge(
      live.projectPath,
      `junta ${worktree.branch} em ${live.base}`,
    );

    if (!closed.ok) {
      await this.worktrees.abortMerge(live.projectPath);
      await this.discard(runId, live, agentId, worktree);
      return {
        status: 'stop',
        reason: `O agente disse que juntou, mas ${closed.files.join(', ')} continua pela metade. Desfiz e nao mudei nada.`,
      };
    }

    this.emit(
      runId,
      draft('worktree.merged', {
        agentId, taskId, branch: worktree.branch, into: live.base,
        filesChanged: closed.filesChanged, resolvedBy: resolverId,
      }),
    );
    await this.remove(runId, live, agentId, worktree, 'merged');
    return { status: 'ok' };
  }

  /** Faz a pergunta e espera. Quem responde e o `answer`, vindo do hub. */
  private askHuman(
    runId: RunId,
    live: LiveRun,
    ask: {
      question: string;
      context: string;
      cause: 'merge_conflict';
      options: readonly { id: string; label: string }[];
      askedBy: AgentId;
      taskId: ReturnType<typeof newTaskId>;
    },
  ): Promise<string> {
    const questionId = newQuestionId();
    this.emit(
      runId,
      draft('human.question_raised', {
        questionId,
        question: ask.question,
        context: ask.context,
        cause: ask.cause,
        askedBy: ask.askedBy,
        taskId: ask.taskId,
        options: [...ask.options],
        allowFreeText: false,
      }),
    );

    return new Promise<string>((resolve) => {
      live.question = {
        questionId,
        resolve: (choice) => {
          this.emit(runId, draft('human.answered', { questionId, answer: choice, optionId: choice }));
          resolve(choice);
        },
      };
    });
  }

  private async remove(
    runId: RunId,
    live: LiveRun,
    agentId: AgentId,
    worktree: Worktree,
    reason: 'merged' | 'discarded',
  ): Promise<void> {
    live.open.delete(agentId);
    await this.worktrees.remove(worktree);
    this.emit(runId, draft('worktree.removed', { agentId, branch: worktree.branch, reason }));
  }

  /** Descartar e remover: o que muda e se o trabalho chegou a entrar no projeto. */
  private discard(runId: RunId, live: LiveRun, agentId: AgentId, worktree: Worktree): Promise<void> {
    return this.remove(runId, live, agentId, worktree, 'discarded');
  }

  /** Nao deixa copia perdida no disco, nem quando a fila termina mal. */
  private async cleanup(runId: RunId, live: LiveRun): Promise<void> {
    for (const [agentId, worktree] of [...live.open]) {
      try {
        await this.discard(runId, live, agentId, worktree);
      } catch (error) {
        console.error('[run-supervisor] nao consegui remover a worktree:', error);
      }
    }
  }

  /** Verdadeiro quando havia mesmo alguem esperando a resposta. */
  answer(runId: RunId, questionId: QuestionId, answer: string, optionId?: string): boolean {
    const live = this.live.get(runId);
    if (live === undefined) return false;

    // A pergunta do supervisor vem primeiro: ela e sobre a fila, nao sobre o
    // que o agente esta fazendo agora.
    const waiting = live.question;
    if (waiting !== null && waiting.questionId === questionId) {
      live.question = null;
      waiting.resolve(optionId ?? answer);
      return true;
    }

    if (live.agent === null) return false;
    live.agent.answer(answer, optionId);
    return true;
  }

  cancel(runId: RunId, reason = 'Voce pediu para parar.'): boolean {
    const live = this.live.get(runId);
    if (live === undefined) return false;

    live.cancelled = true;
    live.agent?.cancel(reason);
    // Uma pergunta aberta viraria espera eterna: parar e a resposta.
    live.question?.resolve(STOP);
    live.question = null;
    return true;
  }

  /** Janela fechando: nao deixa subprocesso orfao rodando no computador. */
  stop(): void {
    for (const [runId] of this.live) this.cancel(runId, 'O aplicativo foi fechado.');
  }
}
