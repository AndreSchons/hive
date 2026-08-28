import { join } from 'node:path';
import {
  budgetSchema,
  draft,
  newAgentId,
  newQuestionId,
  newTaskId,
  readySubtasks,
  type AdapterId,
  type AgentId,
  type AnyEventDraft,
  type Contract,
  type Plan,
  type QuestionId,
  type RoleDefinition,
  type RoleId,
  type Roster,
  type RunId,
  type Subtask,
  type TaskId,
} from '@office/protocol';
import {
  branchFor,
  GitWorktreeManager,
  type AdapterRegistry,
  type AgentRun,
  type Worktree,
} from '@office/agents';
import { AgentPlanner, discoverGates } from '@office/coordination';
import type { EventStore } from '@office/store';

/**
 * Conduz o trabalho de uma execucao, um agente por vez, cada um na propria
 * worktree.
 *
 * Duas portas de entrada: `start` recebe a fila que a pessoa montou na mao, e
 * `startPlanned` recebe so o objetivo e deixa o gerente dividir. Da criacao da
 * worktree em diante os dois caminhos sao o mesmo codigo.
 *
 * Mora no shell de proposito: `coordination` nao pode importar de `apps/`.
 */
export interface QueueItem {
  readonly goal: string;
  readonly role: RoleId;
}

export interface StartRunInput {
  readonly projectPath: string;
  readonly tasks: readonly QueueItem[];
}

export interface StartPlannedInput {
  readonly projectPath: string;
  /** O pedido como a pessoa escreveu. Quem divide e o gerente. */
  readonly goal: string;
}

/**
 * O trabalho de um agente, ja resolvido: veio da fila manual ou de uma subtask
 * do plano. Daqui pra baixo o supervisor nao sabe de onde veio -- worktree,
 * commit e integracao sao identicos nos dois casos.
 */
interface Unit {
  readonly goal: string;
  readonly role: RoleId;
  readonly taskId: TaskId;
  readonly allowedPaths: readonly string[];
  readonly contracts: readonly string[];
  readonly dependsOn: readonly TaskId[];
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
  /** Quem atribuiu. Ausente na fila manual: quem atribuiu foi a propria pessoa. */
  plannedBy?: AgentId;
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
const APPROVE = 'comecar';

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

/** A instrucao de uma subtask planejada, com o criterio de pronto junto. */
function subtaskPrompt(subtask: Subtask): string {
  return [subtask.description, '', `Isto esta pronto quando: ${subtask.doneWhen}`].join('\n');
}

/** Contratos resolvidos em texto: o agente recebe o conteudo, nunca o id. */
function contractBodies(plan: Plan, subtask: Subtask): string[] {
  return subtask.inputContracts
    .map((id) => plan.contracts.find((contract) => contract.id === id))
    .filter((contract): contract is Contract => contract !== undefined)
    .map((contract) => `${contract.title}\n${contract.body}`);
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

  /** Quem integra e quem planeja: o papel com autoridade sobre o dos outros. */
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

  /** Guardas de entrada e o registro da execucao. Comum aos dois caminhos. */
  private async open(projectPath: string, goal: string): Promise<{ runId: RunId; live: LiveRun }> {
    // Sem repositorio nao ha como isolar, e com arvore suja o trabalho da
    // pessoa se misturaria com o dos agentes.
    const check = await this.worktrees.check(projectPath);
    if (!check.ok) throw new Error(check.reason);
    await this.worktrees.prune(projectPath);

    const runId = this.events.createRun({ projectPath, goal });
    this.events.append(runId, {
      type: 'run.started',
      payload: { projectPath, goal, startedBy: 'human' },
    });

    const live: LiveRun = {
      projectPath,
      base: check.branch,
      baseCommit: check.commit,
      startedAt: Date.now(),
      open: new Map(),
      agent: null,
      question: null,
      cancelled: false,
    };
    this.live.set(runId, live);
    return { runId, live };
  }

  async start(input: StartRunInput): Promise<RunId> {
    for (const item of input.tasks) await this.adapterFor(this.role(item.role).adapter);

    const goal = input.tasks.map((item) => item.goal).join(' · ').slice(0, 500);
    const { runId } = await this.open(input.projectPath, goal);

    void this.runQueue(runId, input.tasks);
    return runId;
  }

  /**
   * O caminho do gerente: a pessoa descreve o objetivo e alguem divide.
   *
   * Planejar acontece **antes** de existir worktree. Se o plano nao sair, ou se
   * a pessoa nao aprovar, nada foi criado no disco e nao ha o que desfazer.
   */
  async startPlanned(input: StartPlannedInput): Promise<RunId> {
    await this.adapterFor(this.manager().adapter);
    const { runId } = await this.open(input.projectPath, input.goal);

    void this.planAndRun(runId, input);
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
        const outcome = await this.runOne(runId, live, {
          goal: item.goal,
          role: item.role,
          taskId: newTaskId(),
          allowedPaths: [],
          contracts: [],
          dependsOn: [],
        });
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
    this.close(runId, live, stopped, done, detail);
  }

  /** Planeja, mostra o plano, e so entao executa. */
  private async planAndRun(runId: RunId, input: StartPlannedInput): Promise<void> {
    const live = this.live.get(runId);
    if (live === undefined) return;

    try {
      const manager = this.manager();
      const adapter = await this.adapterFor(manager.adapter);
      if (adapter === undefined) throw new Error('O adaptador do gerente sumiu.');

      const planner = new AgentPlanner({
        adapter,
        role: manager,
        // O gerente aparece no feed lendo o projeto, como qualquer agente.
        emit: (event) => this.events.append(runId, event),
      });

      const result = await planner.plan({
        runId,
        goal: input.goal,
        roster: this.roster,
        project: {
          path: input.projectPath,
          baseBranch: live.base,
          availableGates: discoverGates(input.projectPath),
        },
      });

      if (live.cancelled) {
        this.close(runId, live, 'Voce pediu para parar.', 0);
        return;
      }

      if (result.status === 'needs_input') {
        // O gerente que nao sabe o suficiente pergunta em vez de chutar. Sem
        // plano nao ha execucao: a duvida sobe e a pessoa recomeca com mais
        // detalhe, em vez de o sistema adivinhar e entregar a coisa errada.
        this.emit(
          runId,
          draft('human.question_raised', {
            questionId: newQuestionId(),
            question: result.question,
            context: result.context,
            cause: 'agent_asked',
            options: [],
            allowFreeText: true,
          }),
        );
        this.close(runId, live, `Preciso saber mais antes de dividir: ${result.question}`, 0);
        return;
      }

      const { plan } = result;
      this.emit(runId, draft('plan.created', { plan, createdBy: plan.createdBy }));
      live.plannedBy = plan.createdBy;

      if (!(await this.approvePlan(runId, live, plan))) {
        // Nenhuma worktree foi criada ainda: cancelar aqui nao deixa rastro.
        this.close(runId, live, 'Voce cancelou antes de comecar, e eu nao mexi em nada.', 0);
        return;
      }

      await this.runPlan(runId, live, plan);
    } catch (error) {
      console.error('[run-supervisor] o planejamento falhou:', error);
      await this.cleanup(runId, live);
      this.close(
        runId,
        live,
        'Algo deu errado do meu lado enquanto eu dividia o trabalho, e eu parei antes de mexer no seu projeto.',
        0,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    }
  }

  /** Mostra o plano e espera. O hub desenha os passos a partir de `plan.created`. */
  private async approvePlan(runId: RunId, live: LiveRun, plan: Plan): Promise<boolean> {
    const passos = plan.subtasks.length;
    const choice = await this.askHuman(runId, live, {
      question: `Dividi em ${passos} ${passos === 1 ? 'passo' : 'passos'}. Posso comecar?`,
      context: 'Nada foi mexido ainda. Se preferir, cancele e me conte de outro jeito.',
      cause: 'plan_review',
      options: [
        { id: APPROVE, label: 'Pode comecar' },
        { id: STOP, label: 'Cancelar, quero explicar melhor' },
      ],
    });
    return choice === APPROVE;
  }

  /**
   * Executa o plano em ordem de dependencia, uma subtask por vez.
   *
   * `readySubtasks` devolve as liberadas; pegar sempre a primeira e o que
   * mantem tudo sequencial mesmo quando o grafo permitiria paralelismo.
   */
  private async runPlan(runId: RunId, live: LiveRun, plan: Plan): Promise<void> {
    const completed = new Set<string>();
    const published = new Set<string>();
    let stopped: string | null = null;

    while (completed.size < plan.subtasks.length) {
      if (live.cancelled) {
        stopped = 'Voce pediu para parar.';
        break;
      }

      const next = readySubtasks(plan, completed)[0];
      if (next === undefined) {
        // O grafo ja foi validado na entrada, entao so chega aqui se algo antes
        // travou sem avisar. Parar e mais honesto que rodar pela metade.
        stopped = 'Sobrou passo esperando outro que nao terminou.';
        break;
      }

      this.publishContracts(runId, live, plan, next, published);

      const outcome = await this.runOne(runId, live, {
        goal: subtaskPrompt(next),
        role: next.role,
        taskId: next.id,
        allowedPaths: next.allowedPaths,
        contracts: contractBodies(plan, next),
        dependsOn: next.dependsOn,
      });

      if (outcome.status === 'stop') {
        stopped = outcome.reason;
        break;
      }
      completed.add(next.id);
    }

    await this.cleanup(runId, live);
    this.close(runId, live, stopped, completed.size);
  }

  /**
   * Contrato antes de paralelismo: o que liga o trabalho de dois especialistas
   * entra no log **antes** da primeira subtask que depende dele, nunca depois.
   */
  private publishContracts(
    runId: RunId,
    live: LiveRun,
    plan: Plan,
    subtask: Subtask,
    published: Set<string>,
  ): void {
    for (const id of subtask.inputContracts) {
      if (published.has(id)) continue;
      const contract = plan.contracts.find((candidate) => candidate.id === id);
      if (contract === undefined) continue;
      published.add(id);

      this.emit(
        runId,
        draft('contract.published', {
          contract,
          publishedBy: live.plannedBy ?? plan.createdBy,
          unblocks: plan.subtasks
            .filter((other) => other.inputContracts.includes(id))
            .map((other) => other.id),
        }),
      );
    }
  }

  /** Fecha a execucao e some do mapa. `stopped` nulo = deu certo. */
  private close(
    runId: RunId,
    live: LiveRun,
    stopped: string | null,
    done: number,
    detail?: string,
  ): void {
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
        draft('run.failed', { reason: stopped, ...(detail === undefined ? {} : { detail }) }),
        live.cancelled ? 'cancelled' : 'failed',
      );
    }
    this.live.delete(runId);
  }

  private async runOne(
    runId: RunId,
    live: LiveRun,
    unit: Unit,
  ): Promise<{ readonly status: 'ok' } | { readonly status: 'stop'; readonly reason: string }> {
    const role = this.role(unit.role);
    const adapter = await this.adapterFor(role.adapter);
    if (adapter === undefined) return { status: 'stop', reason: 'O adaptador sumiu.' };

    const agentId = newAgentId(role.id);
    const { taskId } = unit;
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
        taskId, title: unit.goal, role: role.id,
        assignedBy: live.plannedBy ?? 'human', assignedTo: agentId,
        dependsOn: [...unit.dependsOn],
      }),
    );

    const run = adapter.start({
      agentId,
      role: role.id,
      displayName: role.title,
      taskId,
      cwd: worktree.path,
      prompt: buildPrompt(unit.goal),
      allowedPaths: [...unit.allowedPaths],
      contracts: [...unit.contracts],
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
            : `Parei em "${unit.goal}": ${outcomeReason(outcome)}`,
      };
    }

    const salvou = await this.worktrees.commitAll(worktree, unit.goal);
    if (!salvou) {
      await this.discard(runId, live, agentId, worktree);
      return { status: 'ok' };
    }

    return this.integrate(runId, live, { agentId, taskId, worktree, title: unit.goal });
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
    task: { agentId: AgentId; taskId: TaskId; worktree: Worktree; title: string },
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
      taskId: TaskId;
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
      cause: 'merge_conflict' | 'plan_review';
      options: readonly { id: string; label: string }[];
      askedBy?: AgentId;
      taskId?: TaskId;
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
        ...(ask.askedBy === undefined ? {} : { askedBy: ask.askedBy }),
        ...(ask.taskId === undefined ? {} : { taskId: ask.taskId }),
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

    // A pergunta do supervisor vem primeiro: ela e sobre a execucao inteira,
    // nao sobre o que o agente esta fazendo agora.
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
