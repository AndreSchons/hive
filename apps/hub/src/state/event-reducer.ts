import type { AgentState, AnyEvent, BlockCause, Contract, Plan } from '@office/protocol';
import { describeEvent, type FeedItem } from './describe';

export interface AgentView {
  readonly agentId: string;
  readonly role: string;
  readonly displayName: string;
  /** Qual CLI executa este agente. E o que responde "qual IA esta fazendo isso". */
  readonly adapter: string;
  readonly state: AgentState;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly currentTaskId: string | null;
  /** Ultima frase dita. Vai virar balao de fala no escritorio 3D. */
  readonly lastSaid: string | null;
  readonly present: boolean;
}

export type TaskStatus = 'pending' | 'assigned' | 'running' | 'verifying' | 'done' | 'failed';

export interface TaskView {
  readonly taskId: string;
  readonly title: string;
  readonly role: string;
  readonly assignedTo: string | null;
  readonly assignedBy: string | null;
  readonly status: TaskStatus;
  readonly ratio: number;
  readonly dependsOn: readonly string[];
}

export interface PendingQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly context: string;
  readonly cause: BlockCause;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly allowFreeText: boolean;
  readonly askedBy: string | null;
}

export type RunStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface WorldState {
  readonly runId: string | null;
  readonly status: RunStatus;
  readonly goal: string | null;
  readonly lastSeq: number;
  readonly agents: Readonly<Record<string, AgentView>>;
  readonly tasks: Readonly<Record<string, TaskView>>;
  readonly plan: Plan | null;
  readonly contracts: readonly Contract[];
  readonly question: PendingQuestion | null;
  /**
   * O que esta execucao gastou ate agora, somado dos `agent.usage`. Fica no
   * mundo, e nao so no evento de fechamento, para a pessoa acompanhar enquanto
   * roda em vez de descobrir no fim.
   */
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly feed: readonly FeedItem[];
}

export const FEED_LIMIT = 300;

export const emptyWorld: WorldState = {
  runId: null,
  status: 'idle',
  goal: null,
  lastSeq: 0,
  agents: {},
  tasks: {},
  plan: null,
  contracts: [],
  question: null,
  costUsd: 0,
  totalTokens: 0,
  feed: [],
};

/**
 * Reduz o log a um estado do mundo. Puro e total: as mesmas linhas do event
 * store, na mesma ordem, produzem sempre o mesmo mundo -- que e o que permite
 * reencenar uma execucao inteira sem rodar agente nenhum.
 *
 * Aqui nao existe agente, CLI nem modelo: existe evento entrando e mundo saindo.
 */
export function applyEvent(state: WorldState, event: AnyEvent): WorldState {
  // Evento fora de ordem ou repetido nao pode reescrever o mundo. Com WAL e
  // dois processos escrevendo, chegar duplicado e possivel.
  if (event.seq <= state.lastSeq && state.runId === event.runId) return state;

  const base: WorldState = {
    ...(state.runId === event.runId ? state : emptyWorld),
    runId: event.runId,
    lastSeq: event.seq,
    feed: pushFeed(state.runId === event.runId ? state.feed : [], describeEvent(event)),
  };

  switch (event.type) {
    case 'run.started':
      return { ...base, status: 'running', goal: event.payload.goal };
    case 'run.completed':
      return { ...base, status: 'completed', question: null };
    case 'run.failed':
      return { ...base, status: 'failed', question: null };

    case 'plan.created':
      return { ...base, plan: event.payload.plan, tasks: seedTasks(event.payload.plan) };
    case 'plan.revised':
      return { ...base, plan: event.payload.plan, tasks: { ...seedTasks(event.payload.plan), ...base.tasks } };
    case 'contract.published':
      return { ...base, contracts: [...base.contracts, event.payload.contract] };

    case 'agent.spawned': {
      const { agentId, role, displayName, adapter, worktreePath, branch } = event.payload;
      // `worktree.created` chega antes e e quem sabe o branch; a CLI nao sabe.
      return withAgent(base, agentId, (agent) => ({
        agentId, role, displayName, adapter, worktreePath, branch: branch ?? agent.branch,
        state: 'idle', currentTaskId: null, lastSaid: null, present: true,
      }));
    }
    case 'agent.state_changed':
      return withAgent(base, event.payload.agentId, (agent) => ({
        ...agent,
        state: event.payload.to,
        ...(event.payload.reason === undefined ? {} : { lastSaid: event.payload.reason }),
      }));
    case 'agent.despawned':
      return withAgent(base, event.payload.agentId, (agent) => ({
        ...agent, present: false, state: 'done', currentTaskId: null,
      }));
    case 'agent.usage': {
      const { costUsd, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } =
        event.payload;
      return {
        ...base,
        costUsd: base.costUsd + costUsd,
        totalTokens:
          base.totalTokens + inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      };
    }

    case 'task.assigned': {
      const { taskId, title, role, assignedTo, assignedBy, dependsOn } = event.payload;
      return withTask(base, taskId, (task) => ({
        ...task, taskId, title, role, assignedTo, assignedBy,
        status: 'assigned', dependsOn: [...dependsOn],
      }));
    }
    case 'task.started': {
      const withStatus = withTask(base, event.payload.taskId, (task) => ({
        ...task, title: event.payload.title, status: 'running',
      }));
      return withAgent(withStatus, event.payload.agentId, (agent) => ({
        ...agent, currentTaskId: event.payload.taskId,
      }));
    }
    case 'task.progress':
      return withTask(base, event.payload.taskId, (task) => ({
        ...task, ratio: event.payload.ratio ?? task.ratio,
      }));
    case 'task.completed': {
      const done = withTask(base, event.payload.taskId, (task) => ({ ...task, status: 'done', ratio: 1 }));
      return withAgent(done, event.payload.agentId, (agent) => ({ ...agent, currentTaskId: null }));
    }
    case 'task.failed':
      return withTask(base, event.payload.taskId, (task) => ({ ...task, status: 'failed' }));

    case 'gate.started':
      return withTask(base, event.payload.taskId, (task) => ({ ...task, status: 'verifying' }));
    case 'gate.passed':
      return base;
    case 'gate.failed':
      // Portao vermelho devolve a task para o agente: nao e entrega aceita.
      return withTask(base, event.payload.taskId, (task) => ({ ...task, status: 'running' }));

    case 'agent.message':
      return withAgent(base, event.payload.from, (agent) => ({ ...agent, lastSaid: event.payload.summary }));
    case 'agent.handoff':
      return base;

    case 'human.question_raised': {
      const { questionId, question, context, cause, options, allowFreeText, askedBy } = event.payload;
      return {
        ...base,
        question: {
          questionId, question, context, cause,
          options: [...options],
          allowFreeText,
          askedBy: askedBy ?? null,
        },
      };
    }
    case 'human.answered':
      return base.question?.questionId === event.payload.questionId ? { ...base, question: null } : base;

    case 'worktree.created':
      return withAgent(base, event.payload.agentId, (agent) => ({
        ...agent, branch: event.payload.branch, worktreePath: event.payload.path,
      }));

    case 'tool.call':
    case 'tool.result':
    case 'file.changed':
    case 'worktree.conflict':
    case 'worktree.merged':
    case 'worktree.removed':
      return base;

    case 'budget.warning':
    case 'loop.detected':
      return base;
    case 'budget.exceeded':
      return withAgent(base, event.payload.agentId, (agent) => ({ ...agent, state: 'blocked' }));
  }
}

export function applyAll(state: WorldState, events: readonly AnyEvent[]): WorldState {
  return events.reduce(applyEvent, state);
}

function pushFeed(feed: readonly FeedItem[], item: FeedItem): FeedItem[] {
  const next = [...feed, item];
  return next.length > FEED_LIMIT ? next.slice(next.length - FEED_LIMIT) : next;
}

function seedTasks(plan: Plan): Record<string, TaskView> {
  const tasks: Record<string, TaskView> = {};
  for (const subtask of plan.subtasks) {
    tasks[subtask.id] = {
      taskId: subtask.id,
      title: subtask.title,
      role: subtask.role,
      assignedTo: null,
      assignedBy: null,
      status: 'pending',
      ratio: 0,
      dependsOn: [...subtask.dependsOn],
    };
  }
  return tasks;
}

const UNKNOWN_AGENT: Omit<AgentView, 'agentId'> = {
  role: 'desconhecido',
  displayName: 'Agente',
  adapter: '',
  state: 'idle',
  worktreePath: '',
  branch: null,
  currentTaskId: null,
  lastSaid: null,
  present: true,
};

function withAgent(
  state: WorldState,
  agentId: string,
  update: (agent: AgentView) => AgentView,
): WorldState {
  const current = state.agents[agentId] ?? { agentId, ...UNKNOWN_AGENT };
  return { ...state, agents: { ...state.agents, [agentId]: update(current) } };
}

function withTask(state: WorldState, taskId: string, update: (task: TaskView) => TaskView): WorldState {
  const current = state.tasks[taskId] ?? {
    taskId, title: taskId, role: 'desconhecido', assignedTo: null, assignedBy: null,
    status: 'pending' as const, ratio: 0, dependsOn: [],
  };
  return { ...state, tasks: { ...state.tasks, [taskId]: update(current) } };
}
