import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  budgetSchema,
  draft,
  newAgentId,
  newGateId,
  newQuestionId,
  newTaskId,
  readySubtasks,
  type AdapterId,
  type AgentId,
  type AnyEventDraft,
  type BlockCause as QuestionCause,
  type Budget,
  type Contract,
  type Gate,
  type ModelTier,
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
  type AgentAdapter,
  type AgentOutcome,
  type AgentRun,
  type Worktree,
} from '@office/agents';
import {
  AgentPlanner,
  CommandGateRunner,
  DefaultEscalationPolicy,
  InMemoryBudgetTracker,
  InstallWorktreePreparer,
  OPTION_RESOLVE,
  OPTION_RETRY,
  OPTION_STOP,
  chooseCoRunnable,
  contractBrief,
  contractPath,
  defaultGate,
  discoverGates,
  materializeContracts,
  modelFor,
  shiftTier,
  type AnswerUse,
  type BlockCause,
  type BudgetTracker,
  type BudgetVerdict,
  type EscalationPolicy,
  type GateResult,
  type GateRunner,
  type Posture,
  type WorktreePreparer,
} from '@office/coordination';
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
  /** Quanto capricho, escolhido pela pessoa. Ausente = o mais economico. */
  readonly modelTier?: ModelTier;
}

export interface StartPlannedInput {
  readonly projectPath: string;
  /** O pedido como a pessoa escreveu. Quem divide e o gerente. */
  readonly goal: string;
}

/**
 * O trabalho de um agente, ja resolvido: veio da fila manual ou de uma subtask
 * do plano. Daqui pra baixo o supervisor nao sabe de onde veio -- worktree,
 * portao, commit e integracao sao identicos nos dois casos.
 */
interface Unit {
  readonly goal: string;
  readonly role: RoleId;
  readonly taskId: TaskId;
  readonly allowedPaths: readonly string[];
  /** Os combinados que valem para este passo. Viram arquivo na copia do agente. */
  readonly contracts: readonly Contract[];
  readonly dependsOn: readonly TaskId[];
  /** Ausente so quando o projeto nao oferece nenhum comando de verificacao. */
  readonly gate: Gate | undefined;
  readonly budget: Budget;
  /** Alias de modelo ja resolvido. Ausente = default da propria CLI. */
  readonly model: string | undefined;
}

interface PendingQuestion {
  readonly questionId: QuestionId;
  readonly resolve: (choice: string) => void;
}

/**
 * Fila de um so. Existe porque paralelismo nao vale para tudo: preparar a copia
 * semeia um cache compartilhado e integrar mexe no repositorio da pessoa, e as
 * duas coisas so funcionam uma de cada vez, mesmo com dois agentes no ar.
 */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    // Encadeia sempre, inclusive depois de uma falha: um erro no trabalho de
    // quem estava na frente nao pode deixar a fila fechada para sempre.
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** O que uma subtask custou de relogio, para a medida de paralelismo. */
interface Occupancy {
  readonly taskId: TaskId;
  /** Tudo: copia, preparo, agente, portao e integracao. */
  readonly totalMs: number;
  readonly outcome: { readonly status: 'ok' } | { readonly status: 'stop'; readonly reason: string };
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
  /** Os agentes no ar agora. Mais de um quando o plano deixou paralelizar. */
  readonly agents: Map<AgentId, AgentRun>;
  /** Perguntas que o supervisor abriu e ainda espera resposta. */
  readonly questions: Map<QuestionId, PendingQuestion>;
  /**
   * Perguntas que a **propria CLI** abriu, e de quem. Com um agente so dava
   * para mandar a resposta para "o agente"; com dois, entregar ao errado
   * destrava o que nao perguntou e pendura quem perguntou.
   */
  readonly asked: Map<QuestionId, AgentRun>;
  /** Preparar a copia semeia um cache que e um so: dois preparos ao mesmo tempo
   * instalariam duas vezes e disputariam a mesma pasta. */
  readonly prepLock: Lock;
  /** Integrar mexe no repositorio da pessoa. Merge em curso e estado global. */
  readonly mergeLock: Lock;
  cancelled: boolean;
  /**
   * Um passo parou e o plano nao vai mais fechar. Diferente de `cancelled`:
   * quem pediu foi o sistema, nao a pessoa -- mas os dois cortam quem ainda
   * esta no ar em vez de deixar agente trabalhando para um plano morto.
   */
  stopping: boolean;
  /** O que a execucao gastou ate agora, somado dos `agent.usage`. */
  costUsd: number;
  totalTokens: number;
  /**
   * O gasto por agente. Com dois no ar, o total da execucao nao responde
   * "quanto custou desfazer aquela colisao": entre o inicio e o fim da
   * resolucao o outro especialista tambem gastou, e a diferenca do total
   * cobraria dele.
   */
  readonly costByAgent: Map<AgentId, number>;
  /** Quanto tempo foi juntar trabalho, e quanto disso foi desfazer colisao. */
  mergeMs: number;
  conflictMs: number;
  conflicts: number;
  conflictCostUsd: number;
  /** Quem atribuiu. Ausente na fila manual: quem atribuiu foi a propria pessoa. */
  plannedBy?: AgentId;
}

/** O agente em campo numa subtask, com tudo que as tentativas compartilham. */
interface Attempted {
  readonly unit: Unit;
  readonly role: RoleDefinition;
  readonly adapter: AgentAdapter;
  readonly agentId: AgentId;
  readonly worktree: Worktree;
}

/** Como uma subtask terminou depois de todas as tentativas. */
type Delivery =
  /** Portao verde (ou projeto sem portao nenhum): pode integrar. */
  | { readonly status: 'approved' }
  /** O agente nao mudou nada: nao ha o que verificar nem o que integrar. */
  | { readonly status: 'nothing' }
  | { readonly status: 'stop'; readonly reason: string; readonly detail?: string };

/** O que fazer depois de escalar. */
type Escalated =
  | {
      readonly kind: 'retry';
      readonly guidance: string;
      readonly use: AnswerUse;
      /** O que a pessoa respondeu, quando houve pergunta. */
      readonly answer: string;
      /** A pessoa autorizou continuar: o teto volta a valer do zero. */
      readonly renewBudget: boolean;
    }
  | { readonly kind: 'stop'; readonly reason: string; readonly detail?: string };

/**
 * Teto de seguranca, acima da politica de retry e do orcamento. So chega aqui
 * quem responde "tentar de novo" varias vezes seguidas: e a pessoa decidindo,
 * mas decidir nao pode virar laco infinito.
 */
const ATTEMPT_CEILING = 8;

/**
 * Quantos especialistas trabalham ao mesmo tempo.
 *
 * Dois, e nao "quantos o grafo permitir". Cada copia a mais paga instalacao,
 * portao e merge, e o merge e a parte que nao paraleliza -- o repositorio da
 * pessoa e um so. Dois ja transforma soma em caminho critico no caso que
 * importa (duas areas independentes do plano) e mantem a colisao possivel de
 * explicar: quando duas copias se cruzam, sao **estas duas**.
 */
const MAX_PARALLEL = 2;

/**
 * O adaptador nunca encerra bloqueado sem pergunta -- se acontecer e bug nosso,
 * e some numa frase generica em vez de virar uma execucao pendurada.
 */
function outcomeReason(outcome: AgentOutcome): string {
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

/** A sessao que a proxima tentativa retoma, quando a CLI devolveu uma. */
function sessionOf(outcome: AgentOutcome): string | undefined {
  return outcome.status === 'completed' || outcome.status === 'blocked'
    ? outcome.sessionId
    : undefined;
}

/**
 * As tres formas de dizer "pode comecar". O plano ja mostra o modelo
 * recomendado para cada passo; estes botoes movem a escada inteira um degrau
 * para baixo ou para cima, sem obrigar ninguem a escolher passo a passo.
 */
const START: Readonly<Record<string, Posture>> = {
  'comecar-economico': 'economico',
  comecar: 'recomendado',
  'comecar-caprichado': 'caprichado',
};

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

/** Nova tentativa da mesma subtask: o objetivo de novo, com o que deu errado junto. */
function retryPrompt(goal: string, guidance: string): string {
  return [buildPrompt(goal), '', guidance].join('\n');
}

/** Retomada de conversa: o agente ja sabe o objetivo, o que faltava era a resposta. */
function resumePrompt(answer: string, guidance: string): string {
  return [
    'A pessoa respondeu a sua pergunta:',
    '',
    answer,
    '',
    ...(guidance.length > 0 ? [guidance, ''] : []),
    'Siga o trabalho a partir dessa resposta, sem perguntar de novo a mesma coisa.',
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

/** Contratos resolvidos: o agente recebe o conteudo e o arquivo, nunca o id. */
function contractsOf(plan: Plan, subtask: Subtask): Contract[] {
  return subtask.inputContracts
    .map((id) => plan.contracts.find((contract) => contract.id === id))
    .filter((contract): contract is Contract => contract !== undefined);
}

/** A unidade de atividade que da para medir nas duas CLIs. */
const signatureOf = (tool: string, target: string | undefined): string => `${tool}:${target ?? ''}`;

export class RunSupervisor {
  private readonly live = new Map<RunId, LiveRun>();

  constructor(
    private readonly events: EventStore,
    private readonly adapters: AdapterRegistry,
    private readonly roster: Roster,
    private readonly worktrees: GitWorktreeManager,
    /** Onde as copias vivem. Fora do repositorio, decidido por quem conhece o SO. */
    private readonly worktreeRoot: string,
    /** Quem conta se a entrega presta. Nunca o agente que fez o trabalho. */
    private readonly gates: GateRunner = new CommandGateRunner(),
    private readonly escalation: EscalationPolicy = new DefaultEscalationPolicy(),
    private readonly budget: BudgetTracker = new InMemoryBudgetTracker(),
    /** Quem deixa a copia em condicao de rodar o projeto, antes do agente. */
    private readonly prep: WorktreePreparer = new InstallWorktreePreparer(),
  ) {}

  /**
   * Onde as dependencias desta execucao ficam guardadas entre uma subtask e
   * outra. Fora das worktrees de proposito: elas sao apagadas assim que o
   * trabalho entra no projeto, e o cache precisa sobreviver a isso.
   */
  private depsCache(runId: RunId): string {
    return join(this.worktreeRoot, runId, 'deps');
  }

  /**
   * Cache de build compartilhado por todas as copias da execucao.
   *
   * Sem isto cada copia recompila o projeto inteiro do zero, porque a
   * instalacao replicada e anterior a qualquer build. Com ele, a segunda
   * subtask so recompila o que a primeira mexeu. Nao afrouxa o portao: o turbo
   * indexa por hash do conteudo, entao arquivo mexido invalida a entrada. A
   * variavel e ignorada por projeto que nao usa turbo.
   */
  private gateEnv(runId: RunId): Record<string, string> {
    return { TURBO_CACHE_DIR: join(this.depsCache(runId), 'turbo') };
  }

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

  private async adapterFor(id: AdapterId): Promise<AgentAdapter> {
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
      agents: new Map(),
      questions: new Map(),
      asked: new Map(),
      prepLock: new Lock(),
      mergeLock: new Lock(),
      cancelled: false,
      stopping: false,
      costUsd: 0,
      totalTokens: 0,
      costByAgent: new Map(),
      mergeMs: 0,
      conflictMs: 0,
      conflicts: 0,
      conflictCostUsd: 0,
    };
    this.live.set(runId, live);
    return { runId, live };
  }

  async start(input: StartRunInput): Promise<RunId> {
    for (const item of input.tasks) await this.adapterFor(this.role(item.role).adapter);

    const goal = input.tasks.map((item) => item.goal).join(' · ').slice(0, 500);
    const { runId } = await this.open(input.projectPath, goal);

    void this.runQueue(runId, input.tasks, input.modelTier ?? 'economico');
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
    for (const event of events) this.track(runId, event);
  }

  /**
   * Anota no log e soma o que foi gasto. **Todo** evento da execucao passa por
   * aqui, inclusive os do gerente planejando -- o planejamento e uma execucao
   * de CLI como qualquer outra, e deixa-lo de fora faria o total da execucao
   * mentir para menos justamente no passo que roda sempre.
   */
  private track(runId: RunId, event: AnyEventDraft): void {
    this.events.append(runId, event);
    if (event.type !== 'agent.usage') return;

    const live = this.live.get(runId);
    if (live === undefined) return;
    const { costUsd, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } =
      event.payload;
    live.costUsd += costUsd;
    live.totalTokens += inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const { agentId } = event.payload;
    live.costByAgent.set(agentId, (live.costByAgent.get(agentId) ?? 0) + costUsd);
  }

  /**
   * Uma de cada vez: a proxima so comeca depois que a anterior foi integrada.
   *
   * A fila manual nao passa por plano e por isso nao traz portao declarado. O
   * portao do proprio projeto entra aqui -- sem isto este seria o unico caminho
   * do sistema em que "terminei" e aceito sem ninguem conferir.
   */
  private async runQueue(
    runId: RunId,
    items: readonly QueueItem[],
    tier: ModelTier,
  ): Promise<void> {
    const live = this.live.get(runId);
    if (live === undefined) return;

    const gate = defaultGate(live.projectPath);
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
          gate,
          budget: budgetSchema.parse({}),
          // Sem plano nao ha recomendacao por passo, entao vale o degrau que a
          // pessoa escolheu para a fila inteira. Sem isto a fila manual caia no
          // padrao da CLI -- que e o modelo mais caro, no caminho que existe
          // justamente para ser o barato.
          model: modelFor(this.role(item.role), tier),
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

    if (stopped === null && done > 0 && gate !== undefined) {
      const broken = await this.verifyIntegrated(runId, live, [gate]);
      if (broken !== null) {
        stopped = broken.reason;
        detail = broken.detail;
      }
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

      const planner = new AgentPlanner({
        adapter,
        role: manager,
        // O gerente aparece no feed lendo o projeto, como qualquer agente --
        // e o que ele gasta conta no total, pela mesma razao.
        emit: (event) => this.track(runId, event),
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

      const posture = await this.approvePlan(runId, live, plan);
      if (posture === null) {
        // Nenhuma worktree foi criada ainda: cancelar aqui nao deixa rastro.
        this.close(runId, live, 'Voce cancelou antes de comecar, e eu nao mexi em nada.', 0);
        return;
      }

      await this.runPlan(runId, live, plan, posture);
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

  /**
   * Mostra o plano e espera. O hub desenha os passos a partir de
   * `plan.created`, com o modelo recomendado para cada um.
   *
   * A escolha de modelo entra **aqui**, e nao numa tela propria, porque esta ja
   * e uma parada obrigatoria: a pessoa esta olhando os passos e decidindo. Uma
   * segunda pergunta so para escolher modelo seria uma interrupcao a mais para
   * uma decisao que cabe nesta.
   */
  private async approvePlan(runId: RunId, live: LiveRun, plan: Plan): Promise<Posture | null> {
    const passos = plan.subtasks.length;
    const choice = await this.askHuman(runId, live, {
      question: `Dividi em ${passos} ${passos === 1 ? 'passo' : 'passos'}. Posso comecar?`,
      context:
        'Nada foi mexido ainda. Escolhi um modelo para cada passo, mas voce pode pedir tudo mais barato ou tudo mais caprichado.',
      cause: 'plan_review',
      options: [
        { id: 'comecar-economico', label: 'Comecar, gastando o minimo' },
        { id: 'comecar', label: 'Comecar como eu sugeri' },
        { id: 'comecar-caprichado', label: 'Comecar caprichando' },
        { id: OPTION_STOP, label: 'Cancelar, quero explicar melhor' },
      ],
      allowFreeText: false,
    });
    return START[choice] ?? null;
  }

  /**
   * Executa o plano em ordem de dependencia, ate `MAX_PARALLEL` de cada vez.
   *
   * `readySubtasks` diz o que o grafo liberou; `chooseCoRunnable` diz o que e
   * seguro largar junto, e as duas coisas nao sao a mesma. Antes de cada lote
   * partir, os contratos que ele consome viram artefato -- contrato antes de
   * paralelismo nao e ordem no log, e input que ja esta na mao dos dois quando
   * eles comecam.
   */
  private async runPlan(
    runId: RunId,
    live: LiveRun,
    plan: Plan,
    posture: Posture,
  ): Promise<void> {
    const completed = new Set<string>();
    const published = new Set<string>();
    const running = new Map<TaskId, Subtask>();
    const inFlight = new Map<TaskId, Promise<Occupancy>>();

    const startedAt = Date.now();
    let sequentialMs = 0;
    let peakParallel = 1;
    /**
     * Quem ja esperou por area compartilhada. Conjunto, e nao contador: a mesma
     * subtask e reavaliada a cada passo que termina, e somar toda vez mediria
     * quanto tempo ela esperou -- nao quantos passos o plano deixou de
     * paralelizar, que e o que este numero promete.
     */
    const held = new Set<TaskId>();
    let stopped: string | null = null;

    const settle = (done: Occupancy): void => {
      inFlight.delete(done.taskId);
      running.delete(done.taskId);
      sequentialMs += done.totalMs;
      if (done.outcome.status === 'stop') stopped ??= done.outcome.reason;
      else completed.add(done.taskId);
    };

    while (stopped === null && completed.size < plan.subtasks.length) {
      if (live.cancelled) {
        stopped = 'Voce pediu para parar.';
        break;
      }

      const ready = readySubtasks(plan, completed).filter((subtask) => !running.has(subtask.id));
      const choice = chooseCoRunnable(ready, [...running.values()], MAX_PARALLEL);
      for (const esperando of choice.held) held.add(esperando.id);

      // Contrato antes de paralelismo: tudo que o lote consome e publicado
      // **antes** de qualquer um deles comecar, nunca subtask a subtask.
      this.publishContracts(runId, live, plan, choice.start, published);

      for (const subtask of choice.start) {
        running.set(subtask.id, subtask);
        inFlight.set(subtask.id, this.runSubtask(runId, live, plan, subtask, posture));
      }
      peakParallel = Math.max(peakParallel, running.size);

      if (inFlight.size === 0) {
        // O grafo ja foi validado na entrada, entao so chega aqui se algo antes
        // travou sem avisar. Parar e mais honesto que rodar pela metade.
        stopped = 'Sobrou passo esperando outro que nao terminou.';
        break;
      }

      settle(await Promise.race(inFlight.values()));
    }

    // Um passo parou e o plano nao fecha mais: quem ficou no ar nao continua
    // trabalhando de graca. Cortar antes de esperar e o que evita a pessoa
    // olhar um agente ocupado numa execucao que ja acabou.
    if (inFlight.size > 0) {
      this.halt(live);
      for (const done of await Promise.all(inFlight.values())) settle(done);
    }

    this.emit(
      runId,
      draft('plan.measured', {
        wallMs: Date.now() - startedAt,
        sequentialMs,
        mergeMs: live.mergeMs,
        conflictMs: live.conflictMs,
        conflictCostUsd: live.conflictCostUsd,
        conflicts: live.conflicts,
        peakParallel,
        heldForOverlap: held.size,
      }),
    );

    let detail: string | undefined;
    if (stopped === null && completed.size > 0) {
      const broken = await this.verifyIntegrated(
        runId,
        live,
        plan.subtasks.map((subtask) => subtask.gate),
      );
      if (broken !== null) {
        stopped = broken.reason;
        detail = broken.detail;
      }
    }

    await this.cleanup(runId, live);
    this.close(runId, live, stopped, completed.size, detail);
  }

  /**
   * Uma subtask do plano, cronometrada de ponta a ponta.
   *
   * **Nunca rejeita.** Falha nossa vira desfecho, como ja virava na fila
   * manual, e aqui isso deixou de ser so estilo: com duas no ar, uma excecao
   * derrubaria o `Promise.race` e a outra ficaria trabalhando sozinha, fora do
   * controle de quem ia limpar as copias.
   */
  private async runSubtask(
    runId: RunId,
    live: LiveRun,
    plan: Plan,
    subtask: Subtask,
    posture: Posture,
  ): Promise<Occupancy> {
    const startedAt = Date.now();
    const since = (): number => Date.now() - startedAt;

    try {
      const outcome = await this.runOne(runId, live, {
        goal: subtaskPrompt(subtask),
        role: subtask.role,
        taskId: subtask.id,
        allowedPaths: subtask.allowedPaths,
        contracts: contractsOf(plan, subtask),
        dependsOn: subtask.dependsOn,
        gate: subtask.gate,
        budget: subtask.budget,
        // A postura move o degrau que o sistema recomendou; quem resolve o
        // alias e o papel, que e quem conhece a CLI.
        model: modelFor(this.role(subtask.role), shiftTier(subtask.modelTier, posture)),
      });
      return { taskId: subtask.id, totalMs: since(), outcome };
    } catch (error) {
      // A mensagem tecnica fica em `detail`, atras de um clique; a frase
      // principal continua respondivel por quem nao le codigo.
      console.error('[run-supervisor] a subtask falhou:', error);
      this.emit(
        runId,
        draft('task.failed', {
          taskId: subtask.id,
          agentId: live.plannedBy ?? newAgentId('sistema'),
          reason: 'Algo deu errado do meu lado neste passo.',
          detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
        }),
      );
      return {
        taskId: subtask.id,
        totalMs: since(),
        outcome: {
          status: 'stop',
          reason: 'Algo deu errado do meu lado e eu parei antes de mexer no seu projeto.',
        },
      };
    }
  }

  /**
   * Contrato antes de paralelismo: o que liga o trabalho de dois especialistas
   * entra no log **antes** do lote que depende dele, nunca depois -- e antes do
   * lote inteiro, nao antes de cada subtask, senao o segundo especialista
   * receberia como novidade um combinado que o primeiro ja esta usando.
   */
  private publishContracts(
    runId: RunId,
    live: LiveRun,
    plan: Plan,
    batch: readonly Subtask[],
    published: Set<string>,
  ): void {
    for (const subtask of batch) {
      for (const id of subtask.inputContracts) {
        if (published.has(id)) continue;
        const contract = plan.contracts.find((candidate) => candidate.id === id);
        if (contract === undefined) continue;
        published.add(id);

        this.emit(
          runId,
          draft('contract.published', {
            // O caminho onde ele vai estar dentro de cada copia viaja junto: o
            // artefato e o mesmo arquivo para os dois especialistas.
            contract: { ...contract, path: contractPath(contract) },
            publishedBy: live.plannedBy ?? plan.createdBy,
            unblocks: plan.subtasks
              .filter((other) => other.inputContracts.includes(id))
              .map((other) => other.id),
          }),
        );
      }
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
          costUsd: live.costUsd,
          totalTokens: live.totalTokens,
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

    // Preparar antes de o agente comecar, e nao antes do portao: assim ele
    // tambem consegue rodar a verificacao por conta propria enquanto trabalha.
    //
    // Uma copia de cada vez, mesmo com dois agentes no ar: a primeira instala
    // de verdade e semeia o cache da execucao, e as seguintes saem dele por
    // hardlink. Deixar as duas instalarem em paralelo pagaria a instalacao
    // duas vezes para escrever a mesma pasta.
    const prepared = await live.prepLock.run(() =>
      this.prep.prepare(worktree, this.depsCache(runId)),
    );
    if (prepared.status === 'failed') {
      // Nao ha o que o agente conserte aqui, entao nem chega a comecar.
      this.emit(
        runId,
        draft('task.failed', {
          taskId, agentId, reason: prepared.summary, detail: prepared.detail,
        }),
      );
      await this.discard(runId, live, agentId, worktree);
      return { status: 'stop', reason: prepared.summary };
    }
    // O contrato vira arquivo na copia **antes** de o agente comecar. Texto
    // colado no prompt some do contexto quando a conversa cresce; um arquivo
    // ele reabre, e e o mesmo byte na copia do outro especialista.
    await materializeContracts(worktree.path, unit.contracts);

    // O teto vale pela subtask inteira, nao por tentativa: senao "trinta
    // turnos" viraria trinta por tentativa, e o limite deixaria de ser limite.
    this.budget.start(agentId, unit.budget, taskId);
    try {
      const delivery = await this.deliver(runId, live, { unit, role, adapter, agentId, worktree });

      if (delivery.status === 'stop') {
        // A subtask acabou aqui, e o log tem que dizer isso: sem este evento
        // ela ficaria "sendo verificada" para sempre na tela.
        this.emit(
          runId,
          draft('task.failed', {
            taskId,
            agentId,
            reason: delivery.reason,
            ...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
          }),
        );
        // Trabalho reprovado ou interrompido nao entra no projeto: a copia e
        // descartada inteira.
        await this.discard(runId, live, agentId, worktree);
        return { status: 'stop', reason: delivery.reason };
      }
      if (delivery.status === 'nothing') {
        await this.discard(runId, live, agentId, worktree);
        return { status: 'ok' };
      }

      // Integrar e uma de cada vez sempre: o repositorio da pessoa e um so, e
      // um merge em curso e estado global -- dois ao mesmo tempo nao existe.
      // E aqui que o paralelismo volta a virar fila, e por isso e este tempo
      // que a medida separa do resto.
      const mergeStartedAt = Date.now();
      try {
        return await live.mergeLock.run(() =>
          this.integrate(runId, live, { agentId, taskId, worktree, title: unit.goal }),
        );
      } finally {
        live.mergeMs += Date.now() - mergeStartedAt;
      }
    } finally {
      this.budget.release(agentId);
    }
  }

  /**
   * As tentativas de uma subtask.
   *
   * O ciclo e sempre o mesmo: o agente trabalha, o portao confere por fora, e o
   * que nao passa vira uma decisao -- tentar de novo com o erro na mao, ou
   * perguntar. Nenhum agente aprova o proprio trabalho, entao o unico jeito de
   * sair daqui aprovado e o portao ficar verde.
   */
  private async deliver(runId: RunId, live: LiveRun, ctx: Attempted): Promise<Delivery> {
    const { unit, role, adapter, agentId, worktree } = ctx;
    const { taskId } = unit;

    let attempt = 1;
    let prompt = buildPrompt(unit.goal);
    let session: string | undefined;
    /**
     * Se ja existe trabalho commitado nesta copia. E o que separa "o agente
     * nao fez nada" de "o agente nao consertou nada": na segunda tentativa a
     * copia continua com o codigo reprovado da primeira, e tratar isso como
     * "nada a fazer" fecharia a execucao dizendo que entregou.
     */
    let produced = false;

    while (attempt <= ATTEMPT_CEILING) {
      const run = adapter.start({
        agentId,
        role: role.id,
        displayName: role.title,
        taskId,
        cwd: worktree.path,
        prompt,
        allowedPaths: [...unit.allowedPaths],
        contracts: unit.contracts.map(contractBrief),
        // O que sobrou, nao o teto cheio: quem gastou vinte turnos na primeira
        // tentativa nao recomeca com trinta.
        budget: this.budget.remaining(agentId),
        ...(unit.model === undefined ? {} : { model: unit.model }),
        ...(session === undefined ? {} : { sessionId: session }),
      });

      const { outcome, tripped } = await this.pump(runId, live, run, agentId, taskId);
      // Parada da pessoa ou de outro passo do plano: nos dois casos nao ha o
      // que escalar. Escalar aqui abriria uma pergunta sobre um trabalho que
      // ninguem vai mais integrar.
      if (halted(live)) return { status: 'stop', reason: haltReason(live) };
      session = sessionOf(outcome) ?? session;

      const cause = blockCauseOf(outcome, tripped);
      let next: Escalated;

      if (cause === null) {
        produced = (await this.worktrees.commitAll(worktree, unit.goal)) || produced;
        // Agente que nao mexeu em nada nao tem o que verificar nem o que
        // integrar -- e um portao verde aqui nao provaria coisa nenhuma.
        if (!produced) return { status: 'nothing' };

        if (unit.gate === undefined) return { status: 'approved' };
        const result = await this.runGate(runId, ctx, unit.gate);
        if (result.status === 'passed') return { status: 'approved' };

        next = await this.escalate(runId, live, ctx, { kind: 'gate_failed', result }, attempt);
      } else {
        next = await this.escalate(runId, live, ctx, cause, attempt);
      }

      if (next.kind === 'stop') {
        return {
          status: 'stop',
          reason: next.reason,
          ...(next.detail === undefined ? {} : { detail: next.detail }),
        };
      }

      attempt += 1;
      prompt =
        next.use === 'session'
          ? resumePrompt(next.answer, next.guidance)
          : retryPrompt(unit.goal, next.guidance);
      if (next.renewBudget) this.budget.start(agentId, unit.budget, taskId);
    }

    return {
      status: 'stop',
      reason: 'Tentamos varias vezes e nao chegou a uma entrega que passasse na verificacao.',
    };
  }

  /**
   * Roda o portao e conta no log o que aconteceu. Quem executa e um comando do
   * proprio projeto, por fora do agente: e a unica coisa que separa "terminei"
   * de "esta pronto".
   */
  private async runGate(runId: RunId, ctx: Attempted, gate: Gate): Promise<GateResult> {
    const { agentId, worktree, unit } = ctx;
    const { taskId } = unit;
    const gateId = newGateId();

    this.emit(
      runId,
      draft('gate.started', { gateId, taskId, agentId, kind: gate.kind, command: gate.command }),
    );

    const result = await this.gates.run({ gate, worktree, taskId, env: this.gateEnv(runId) });

    this.emit(
      runId,
      result.status === 'passed'
        ? draft('gate.passed', { gateId, taskId, agentId, kind: gate.kind, durationMs: result.durationMs })
        : draft('gate.failed', {
            gateId,
            taskId,
            agentId,
            kind: gate.kind,
            // Nao ha codigo de saida quando o comando nem chegou a terminar,
            // nem quando ele nao chegou a rodar; o que separa os casos e a
            // frase, nao o numero.
            exitCode: result.status === 'failed' ? result.exitCode : -1,
            summary: result.summary,
            // Comando silencioso existe (`grep -q`), e um detalhe vazio atras
            // de um clique so frustra quem clica.
            ...(result.detail.length === 0 ? {} : { detail: result.detail }),
          }),
    );
    return result;
  }

  /**
   * O projeto inteiro, depois de tudo integrado.
   *
   * Os portoes das subtasks rodam cada um na copia do seu agente, sobre o
   * trabalho daquele agente. Nenhum deles ve o resultado da juncao -- e e
   * exatamente ai que mora a quebra que ninguem previu: dois passos que passam
   * sozinhos e nao passam juntos. Devolve a frase do problema, ou `null`.
   */
  private async verifyIntegrated(
    runId: RunId,
    live: LiveRun,
    gates: readonly Gate[],
  ): Promise<{ readonly reason: string; readonly detail: string } | null> {
    // O repositorio da pessoa, no branch base: e onde o trabalho ja esta.
    const integrated: Worktree = {
      agentId: newAgentId('verificacao'),
      repositoryPath: live.projectPath,
      path: live.projectPath,
      branch: live.base,
      base: live.base,
      createdAt: Date.now(),
    };

    // O repositorio da pessoa quase sempre ja tem as dependencias -- e onde ela
    // desenvolve. Quando nao tem, elas vem do cache desta execucao por
    // hardlink: sem isso o portao final reprovaria por falta de dependencia, e
    // nao pelo que os agentes fizeram.
    const prepared = await this.prep.prepare(integrated, this.depsCache(runId));
    if (prepared.status === 'failed') {
      return { reason: prepared.summary, detail: prepared.detail };
    }

    const seen = new Set<string>();
    for (const gate of gates) {
      if (seen.has(gate.command)) continue;
      seen.add(gate.command);
      if (live.cancelled) return null;

      const gateId = newGateId();
      const taskId = newTaskId();
      this.emit(
        runId,
        draft('gate.started', {
          gateId, taskId, agentId: integrated.agentId, kind: gate.kind, command: gate.command,
        }),
      );

      const result = await this.gates.run({
        gate, worktree: integrated, taskId, env: this.gateEnv(runId),
      });
      if (result.status === 'passed') {
        this.emit(
          runId,
          draft('gate.passed', {
            gateId, taskId, agentId: integrated.agentId, kind: gate.kind,
            durationMs: result.durationMs,
          }),
        );
        continue;
      }

      this.emit(
        runId,
        draft('gate.failed', {
          gateId, taskId, agentId: integrated.agentId, kind: gate.kind,
          exitCode: result.status === 'failed' ? result.exitCode : -1,
          summary: result.summary,
          ...(result.detail.length === 0 ? {} : { detail: result.detail }),
        }),
      );
      return {
        // O trabalho **ja esta** no projeto: dizer isso e o minimo, porque o
        // que a pessoa precisa decidir agora e se desfaz ou se conserta.
        reason:
          'Cada passo passou na verificacao sozinho, mas o projeto inteiro nao passa com tudo junto. O trabalho ja esta no seu projeto -- confira antes de seguir.',
        detail: result.detail,
      };
    }
    return null;
  }

  /**
   * Traduz a parada em decisao. Tentar de novo e barato e resolve a maior parte
   * dos portoes vermelhos; perguntar custa a atencao da pessoa, e por isso so
   * entra quando tentar de novo ja falhou.
   */
  private async escalate(
    runId: RunId,
    live: LiveRun,
    ctx: Attempted,
    cause: BlockCause,
    attempt: number,
  ): Promise<Escalated> {
    const { agentId, unit } = ctx;
    const decision = this.escalation.decide({ agentId, taskId: unit.taskId, cause, attempt });

    switch (decision.action) {
      case 'abort':
        return { kind: 'stop', reason: decision.reason, ...detailOf(cause) };

      case 'retry':
        this.emit(
          runId,
          draft('task.progress', { taskId: unit.taskId, agentId, note: retryNote(cause) }),
        );
        // Tentativa por conta da casa: nao renova o teto. Quem paga a segunda
        // chance e o orcamento que a subtask ja tinha.
        return { kind: 'retry', guidance: decision.guidance, use: 'restart', answer: '', renewBudget: false };

      case 'ask': {
        const { question } = decision;
        const answer = await this.askHuman(runId, live, {
          question: question.question,
          context: question.context,
          cause: question.cause,
          options: question.options,
          allowFreeText: question.allowFreeText,
          askedBy: agentId,
          taskId: unit.taskId,
        });

        if (answer === OPTION_STOP) {
          return {
            kind: 'stop',
            reason: 'Parei sem integrar nada, como voce pediu.',
            ...detailOf(cause),
          };
        }

        // Escolher o botao nao acrescenta instrucao; texto livre, sim -- quem
        // conhece o projeto costuma saber a pista que estava faltando.
        const words = answer === OPTION_RETRY ? '' : answer;
        const guidance =
          words.length > 0 && decision.onAnswer !== 'session'
            ? [decision.guidance, `A pessoa acrescentou: ${words}`]
                .filter((part) => part.length > 0)
                .join('\n\n')
            : decision.guidance;

        return {
          kind: 'retry',
          guidance,
          use: decision.onAnswer,
          answer,
          // Quem mandou continuar foi a pessoa, entao o teto volta a valer do
          // zero. Sem isso ela autorizaria uma tentativa que ja nasce com um
          // turno de orcamento e para de novo no primeiro passo.
          renewBudget: true,
        };
      }
    }
  }

  /**
   * Leva os eventos do adaptador para o log, que e a unica fonte da verdade, e
   * de passagem conta as acoes contra o orcamento.
   *
   * Contar aqui e o que faz o limite valer atraves das tentativas: o adaptador
   * so conhece a execucao dele, e uma subtask que tentou tres vezes teria tres
   * orcamentos cheios se ninguem somasse.
   */
  private async pump(
    runId: RunId,
    live: LiveRun,
    run: AgentRun,
    agentId: AgentId,
    taskId: TaskId,
  ): Promise<{ outcome: AgentOutcome; tripped: BudgetVerdict | null }> {
    live.agents.set(agentId, run);
    // Uma execucao que ja esta parando nao ganha um agente novo trabalhando.
    if (halted(live)) run.cancel(haltReason(live));
    let tripped: BudgetVerdict | null = null;

    const trip = (verdict: BudgetVerdict, ...events: AnyEventDraft[]): void => {
      if (tripped !== null) return;
      tripped = verdict;
      this.emit(runId, ...events);
      // Estourou, para e pergunta -- nunca segue tentando as cegas.
      run.cancel('O limite combinado para este passo acabou.');
    };

    try {
      for await (const event of run) {
        this.track(runId, event);
        // A CLI suspendeu o agente para perguntar. Guardar de quem e a pergunta
        // e o que permite entregar a resposta ao agente certo quando ha dois no
        // ar -- entregar ao outro destravaria quem nao perguntou.
        if (event.type === 'human.question_raised' && event.payload.askedBy === agentId) {
          live.asked.set(event.payload.questionId, run);
        }
        if (event.type === 'human.answered') live.asked.delete(event.payload.questionId);
        if (tripped !== null) continue;

        // O que o proprio adaptador ja detectou tambem para a execucao: o
        // evento ja esta no log, entao aqui so falta agir sobre ele.
        if (event.type === 'budget.exceeded') {
          trip({
            status: 'exceeded',
            kind: event.payload.kind === 'time' ? 'time' : 'turns',
            used: event.payload.used,
            limit: event.payload.limit,
          });
          continue;
        }
        if (event.type === 'loop.detected') {
          trip({
            status: 'looping',
            signature: event.payload.signature,
            occurrences: event.payload.occurrences,
          });
          continue;
        }
        if (event.type !== 'tool.call') continue;

        const verdict = this.budget.record(
          agentId,
          signatureOf(event.payload.tool, event.payload.target),
        );
        if (verdict.status === 'warning') {
          this.emit(
            runId,
            draft('budget.warning', {
              agentId, kind: verdict.kind, used: verdict.used, limit: verdict.limit,
            }),
          );
        } else if (verdict.status === 'exceeded') {
          trip(
            verdict,
            draft('budget.exceeded', {
              agentId, kind: verdict.kind, used: verdict.used, limit: verdict.limit,
            }),
          );
        } else if (verdict.status === 'looping') {
          trip(
            verdict,
            draft('loop.detected', {
              agentId, taskId, signature: verdict.signature, occurrences: verdict.occurrences,
            }),
          );
        }
      }
    } catch (error) {
      console.error('[run-supervisor] o stream do agente falhou:', error);
    } finally {
      live.agents.delete(agentId);
      for (const [questionId, waiting] of [...live.asked]) {
        if (waiting === run) live.asked.delete(questionId);
      }
    }
    return { outcome: await run.outcome, tripped };
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
    // O que desfazer colisao custou, separado do merge limpo: fila sequencial
    // tambem paga merge, mas so paralelismo cria colisao -- e e essa parte que
    // diz se a etapa de contrato fez o trabalho dela.
    const conflictStartedAt = Date.now();
    live.conflicts += 1;
    /** Quem desfaz a colisao, quando chega a existir um. */
    let resolver: AgentId | null = null;
    const chargeConflict = (): void => {
      live.conflictMs += Date.now() - conflictStartedAt;
      if (resolver !== null) live.conflictCostUsd += live.costByAgent.get(resolver) ?? 0;
    };

    this.emit(
      runId,
      draft('worktree.conflict', {
        agentId, taskId, branch: worktree.branch, into: live.base, files: [...files],
      }),
    );

    // A mesma politica que decide portao e orcamento: toda frase que a pessoa
    // le sobre uma parada sai de um lugar so.
    const decision = this.escalation.decide({
      agentId, taskId, attempt: 1, cause: { kind: 'merge_conflict', files },
    });
    if (decision.action !== 'ask') {
      await this.worktrees.abortMerge(live.projectPath);
      await this.discard(runId, live, agentId, worktree);
      chargeConflict();
      return { status: 'stop', reason: `Parei sem juntar o trabalho em ${lista}.` };
    }

    const choice = await this.askHuman(runId, live, {
      question: decision.question.question,
      context: decision.question.context,
      cause: decision.question.cause,
      options: decision.question.options,
      allowFreeText: decision.question.allowFreeText,
      askedBy: agentId,
      taskId,
    });

    if (choice !== OPTION_RESOLVE) {
      // Desfaz o merge: o repositorio volta exatamente como estava.
      await this.worktrees.abortMerge(live.projectPath);
      await this.discard(runId, live, agentId, worktree);
      chargeConflict();
      return {
        status: 'stop',
        reason: `Parei sem juntar: ${lista} foi editado por dois agentes e a decisao e sua.`,
      };
    }

    const manager = this.manager();
    const adapter = await this.adapterFor(manager.adapter);

    const resolverId = newAgentId(manager.id);
    resolver = resolverId;
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

    const { outcome } = await this.pump(runId, live, run, resolverId, taskId);
    if (outcome.status !== 'completed') {
      await this.worktrees.abortMerge(live.projectPath);
      await this.discard(runId, live, agentId, worktree);
      chargeConflict();
      return {
        status: 'stop',
        reason: `Nao consegui juntar os dois trabalhos em ${lista}: ${outcomeReason(outcome)}`,
      };
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
      chargeConflict();
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
    chargeConflict();
    return { status: 'ok' };
  }

  /** Faz a pergunta e espera. Quem responde e o `answer`, vindo do hub. */
  private askHuman(
    runId: RunId,
    live: LiveRun,
    ask: {
      question: string;
      context: string;
      cause: QuestionCause;
      options: readonly { id: string; label: string }[];
      allowFreeText: boolean;
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
        allowFreeText: ask.allowFreeText,
      }),
    );

    return new Promise<string>((resolve) => {
      const pending: PendingQuestion = {
        questionId,
        resolve: (choice) => {
          live.questions.delete(questionId);
          this.emit(runId, draft('human.answered', { questionId, answer: choice, optionId: choice }));
          resolve(choice);
        },
      };
      live.questions.set(questionId, pending);
      // Perguntar durante uma parada seria esperar para sempre por alguem que
      // ja foi embora. A pergunta ja esta no log; a resposta e "parar".
      if (halted(live)) pending.resolve(OPTION_STOP);
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
    // O cache de dependencias sai junto: ele so vale para esta execucao, e sao
    // links, entao apagar nao mexe em nada que outra execucao esteja usando.
    await rm(join(this.worktreeRoot, runId), { recursive: true, force: true });
  }

  /** Verdadeiro quando havia mesmo alguem esperando a resposta. */
  answer(runId: RunId, questionId: QuestionId, answer: string, optionId?: string): boolean {
    const live = this.live.get(runId);
    if (live === undefined) return false;

    // A pergunta do supervisor vem primeiro: ela e sobre a execucao inteira,
    // nao sobre o que o agente esta fazendo agora.
    const waiting = live.questions.get(questionId);
    if (waiting !== undefined) {
      live.questions.delete(questionId);
      waiting.resolve(optionId ?? answer);
      return true;
    }

    // A resposta vai para **quem perguntou**, e nunca para "o agente": com dois
    // no ar, mandar ao errado destrava quem nao perguntou e pendura quem
    // perguntou, e nada na tela explicaria por que.
    const asked = live.asked.get(questionId);
    if (asked === undefined) return false;
    live.asked.delete(questionId);
    asked.answer(answer, optionId);
    return true;
  }

  cancel(runId: RunId, reason = 'Voce pediu para parar.'): boolean {
    const live = this.live.get(runId);
    if (live === undefined) return false;

    live.cancelled = true;
    this.halt(live, reason);
    return true;
  }

  /**
   * Corta todo mundo que ainda esta no ar e nao deixa pergunta aberta.
   *
   * Serve para a pessoa mandar parar e para um passo do plano ter parado
   * sozinho: nos dois casos o resto do trabalho ja nao vai ser integrado, e
   * agente rodando sem destino gasta dinheiro de quem esta olhando.
   */
  private halt(live: LiveRun, reason?: string): void {
    live.stopping = true;
    const why = reason ?? haltReason(live);
    for (const run of live.agents.values()) run.cancel(why);
    // Pergunta aberta viraria espera eterna: parar e a resposta.
    for (const pending of [...live.questions.values()]) pending.resolve(OPTION_STOP);
  }

  /** Janela fechando: nao deixa subprocesso orfao rodando no computador. */
  stop(): void {
    for (const [runId] of this.live) this.cancel(runId, 'O aplicativo foi fechado.');
  }
}

/**
 * A execucao ainda esta valendo? Parada da pessoa e parada do sistema chegam
 * por caminhos diferentes e significam a mesma coisa daqui pra frente: nao
 * escale, nao pergunte, nao integre.
 */
const halted = (live: LiveRun): boolean => live.cancelled || live.stopping;

const haltReason = (live: LiveRun): string =>
  live.cancelled ? 'Voce pediu para parar.' : 'Outro passo do plano parou antes deste terminar.';

/** O que o feed conta enquanto o agente tenta de novo por conta propria. */
function retryNote(cause: BlockCause): string {
  switch (cause.kind) {
    case 'gate_failed':
      return 'A verificacao apontou problemas e eu pedi uma correcao.';
    case 'agent_crashed':
      return 'O agente parou no meio do caminho e eu pedi para ele continuar.';
    case 'agent_asked':
    case 'budget':
    case 'merge_conflict':
      return 'Pedi para tentar de novo.';
  }
}

/**
 * O detalhe tecnico da parada, quando existe. Fica separado da frase e atras de
 * um clique, nunca no corpo dela.
 */
function detailOf(cause: BlockCause): { detail?: string } {
  switch (cause.kind) {
    case 'gate_failed':
      return cause.result.detail.length === 0 ? {} : { detail: cause.result.detail };
    case 'agent_crashed':
      return cause.detail === undefined ? {} : { detail: cause.detail };
    case 'agent_asked':
    case 'budget':
    case 'merge_conflict':
      return {};
  }
}

/**
 * Por que a tentativa nao chegou a uma entrega. `null` quer dizer que o agente
 * disse que terminou -- o que ainda nao e o mesmo que estar pronto.
 */
function blockCauseOf(outcome: AgentOutcome, tripped: BudgetVerdict | null): BlockCause | null {
  if (tripped !== null) return { kind: 'budget', verdict: tripped };

  switch (outcome.status) {
    case 'completed':
      return null;
    case 'blocked':
      return {
        kind: 'agent_asked',
        question: outcome.question,
        context: 'O agente parou para perguntar antes de seguir.',
      };
    case 'failed':
      return {
        kind: 'agent_crashed',
        reason: outcome.reason,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };
    // Cancelamento que nao veio da pessoa e a CLI desistindo por conta propria:
    // o motivo dela ja e a frase, e o caminho e o mesmo de uma queda.
    case 'cancelled':
      return { kind: 'agent_crashed', reason: outcome.reason };
  }
}
