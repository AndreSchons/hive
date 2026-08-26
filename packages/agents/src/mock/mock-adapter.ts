import {
  adapterId,
  draft,
  newQuestionId,
  type AdapterId,
  type AnyEventDraft,
} from '@office/protocol';
import type {
  AdapterCapabilities,
  AdapterProbe,
  AgentAdapter,
  AgentOutcome,
  AgentRun,
  AgentRunRequest,
} from '../adapter';
import { AsyncQueue } from '../process/async-queue';

export interface MockAdapterOptions {
  /** Pausa entre eventos. 0 nos testes, algo visivel na demonstracao. */
  readonly stepDelayMs?: number;
  /**
   * Faz o agente travar e perguntar ao humano antes de terminar. A execucao so
   * continua quando `answer()` for chamado.
   */
  readonly blockWith?: {
    readonly question: string;
    readonly context: string;
    readonly options?: readonly { readonly id: string; readonly label: string }[];
  };
  /** Faz a subtask falhar no portao em vez de passar. */
  readonly failGate?: string;
}

const capabilities: AdapterCapabilities = {
  streamsJson: true,
  resumesSession: true,
  acceptsExtraDirs: true,
  reportsToolCalls: true,
};

/**
 * Agente falso. Existe para exercitar a interface de ponta a ponta -- inclusive
 * o caminho de bloqueio e retomada -- antes de qualquer CLI real entrar.
 */
export class MockAdapter implements AgentAdapter {
  readonly id: AdapterId = adapterId.parse('mock');
  readonly displayName = 'Agente simulado';
  readonly capabilities = capabilities;

  constructor(private readonly options: MockAdapterOptions = {}) {}

  probe(): Promise<AdapterProbe> {
    return Promise.resolve({ available: true, version: '0.0.1', executable: '(embutido)' });
  }

  start(request: AgentRunRequest): AgentRun {
    return new MockRun(request, this.options);
  }
}

class MockRun implements AgentRun {
  readonly agentId;
  private readonly queue = new AsyncQueue<AnyEventDraft>();
  private readonly answered: Promise<string>;
  private resolveAnswer: (answer: string) => void = () => {};
  private settle: (outcome: AgentOutcome) => void = () => {};
  private cancelled: string | null = null;
  readonly outcome: Promise<AgentOutcome>;

  constructor(
    private readonly request: AgentRunRequest,
    private readonly options: MockAdapterOptions,
  ) {
    this.agentId = request.agentId;
    this.answered = new Promise<string>((resolve) => {
      this.resolveAnswer = resolve;
    });
    this.outcome = new Promise<AgentOutcome>((resolve) => {
      this.settle = resolve;
    });
    void this.script();
  }

  [Symbol.asyncIterator](): AsyncIterator<AnyEventDraft> {
    return this.queue[Symbol.asyncIterator]();
  }

  answer(answer: string): void {
    this.resolveAnswer(answer);
  }

  cancel(reason: string): void {
    if (this.cancelled !== null) return;
    this.cancelled = reason;
    this.resolveAnswer('(cancelado)');
  }

  private async emit(event: AnyEventDraft): Promise<void> {
    this.queue.push(event);
    const delay = this.options.stepDelayMs ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private finish(outcome: AgentOutcome): void {
    this.settle(outcome);
    this.queue.close();
  }

  private async script(): Promise<void> {
    const { agentId, taskId, role, cwd, prompt } = this.request;
    const state = (from: string, to: string, reason?: string): AnyEventDraft =>
      draft('agent.state_changed', {
        agentId,
        from: parseState(from),
        to: parseState(to),
        ...(reason === undefined ? {} : { reason }),
      });

    try {
      await this.emit(
        draft('agent.spawned', {
          agentId,
          role,
          displayName: `${role} (simulado)`,
          adapter: adapterId.parse('mock'),
          worktreePath: cwd,
          branch: `office/${role}`,
        }),
      );
      if (this.stopIfCancelled()) return;

      await this.emit(state('idle', 'thinking', 'Lendo a instrucao'));
      if (taskId) await this.emit(draft('task.started', { taskId, agentId, title: shorten(prompt) }));

      await this.emit(state('thinking', 'working'));
      await this.emit(
        draft('tool.call', {
          agentId,
          ...(taskId ? { taskId } : {}),
          tool: 'Edit',
          target: 'src/exemplo.ts',
          summary: 'Ajustando o arquivo principal',
        }),
      );
      await this.emit(
        draft('file.changed', {
          agentId,
          ...(taskId ? { taskId } : {}),
          path: 'src/exemplo.ts',
          change: 'modified',
          linesAdded: 12,
          linesRemoved: 3,
        }),
      );
      if (this.stopIfCancelled()) return;

      if (this.options.blockWith) {
        const questionId = newQuestionId();
        const { question, context, options = [] } = this.options.blockWith;
        await this.emit(state('working', 'blocked', question));
        await this.emit(
          draft('human.question_raised', {
            questionId,
            question,
            context,
            askedBy: agentId,
            ...(taskId ? { taskId } : {}),
            options: [...options],
          }),
        );

        const answer = await this.answered;
        if (this.cancelled !== null) {
          this.finish({ status: 'cancelled', reason: this.cancelled });
          return;
        }
        await this.emit(draft('human.answered', { questionId, answer }));
        await this.emit(state('blocked', 'working', 'Retomando com a resposta'));
      }

      if (taskId) {
        await this.emit(draft('task.progress', { taskId, agentId, note: 'Rodando a verificacao', ratio: 0.8 }));

        const gateId = gateIdFor(taskId);
        await this.emit(
          draft('gate.started', { gateId, taskId, agentId, kind: 'typecheck', command: 'pnpm typecheck' }),
        );

        if (this.options.failGate) {
          await this.emit(
            draft('gate.failed', {
              gateId,
              taskId,
              agentId,
              kind: 'typecheck',
              exitCode: 1,
              summary: this.options.failGate,
            }),
          );
          await this.emit(draft('task.failed', { taskId, agentId, reason: this.options.failGate }));
          await this.emit(state('working', 'done'));
          this.finish({ status: 'failed', reason: this.options.failGate, exitCode: 1 });
          return;
        }

        await this.emit(draft('gate.passed', { gateId, taskId, agentId, kind: 'typecheck', durationMs: 1200 }));
        await this.emit(
          draft('task.completed', { taskId, agentId, summary: 'Entrega simulada', filesChanged: 1 }),
        );
      }

      await this.emit(state('working', 'done'));
      this.finish({ status: 'completed', summary: 'Entrega simulada', turns: 4, sessionId: `mock-${agentId}` });
    } catch (error) {
      this.queue.fail(error);
      this.settle({
        status: 'failed',
        reason: 'O agente simulado parou de forma inesperada.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopIfCancelled(): boolean {
    if (this.cancelled === null) return false;
    this.finish({ status: 'cancelled', reason: this.cancelled });
    return true;
  }
}

const STATES = ['idle', 'thinking', 'working', 'blocked', 'talking', 'done'] as const;
type State = (typeof STATES)[number];

function parseState(value: string): State {
  const found = STATES.find((state) => state === value);
  if (found === undefined) throw new Error(`estado desconhecido: ${value}`);
  return found;
}

function gateIdFor(taskId: string): string {
  return `gat_${taskId}`;
}

function shorten(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
