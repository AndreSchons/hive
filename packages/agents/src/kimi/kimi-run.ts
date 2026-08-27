import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  draft,
  newQuestionId,
  type AnyEventDraft,
  type QuestionId,
} from '@office/protocol';
import type { AgentOutcome, AgentRun, AgentRunRequest } from '../adapter';
import { AsyncQueue } from '../process/async-queue';
import { decidePermission, type PermissionDecision, type ToolKind } from '../permission';
import { AcpClient } from './acp-client';
import {
  requestPermissionParamsSchema,
  sessionUpdateSchema,
  stopReasonSchema,
  type PermissionOption,
  type StopReason,
} from './acp-messages';
import { AcpTranslator, type KimiTranslateContext } from './acp-translate';

export interface KimiRunOptions {
  readonly executable: string;
  readonly killGraceMs?: number;
}

/**
 * O que ficou pendente enquanto o agente espera o humano. `resolve` e a propria
 * resposta do JSON-RPC: enquanto ela nao for chamada, o agente segue suspenso.
 */
interface PendingAsk {
  readonly questionId: QuestionId;
  readonly options: readonly PermissionOption[];
  readonly decision: Extract<PermissionDecision, { kind: 'escalate' }>;
  readonly resolve: (value: unknown) => void;
}

const STDERR_CAP = 8_000;

const KINDS = new Set<ToolKind>([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other',
]);
const toolKind = (value: string | undefined): ToolKind | undefined =>
  value !== undefined && KINDS.has(value as ToolKind) ? (value as ToolKind) : undefined;

/**
 * Uma execucao do Kimi pelo Agent Client Protocol.
 *
 * O modo `-p` da CLI nao serve aqui: ele forca permissao automatica, descarta o
 * pensamento e nao aceita nada pelo stdin, entao o agente nunca poderia parar
 * para perguntar. Pelo ACP o agente **suspende** num pedido de permissao e so
 * segue quando respondemos -- que e a experiencia principal do produto.
 */
export class KimiRun implements AgentRun {
  readonly agentId;
  readonly outcome: Promise<AgentOutcome>;

  private readonly queue = new AsyncQueue<AnyEventDraft>();
  private readonly translator: AcpTranslator;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly client: AcpClient;
  private readonly killGraceMs: number;

  private settle: (outcome: AgentOutcome) => void = () => {};
  private finished = false;
  private pending: PendingAsk | null = null;
  private sessionId: string | null = null;
  private stderr = '';
  private lastMessage = '';
  private cancelReason: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly request: AgentRunRequest,
    context: Omit<KimiTranslateContext, 'budget' | 'cwd'>,
    options: KimiRunOptions,
  ) {
    this.agentId = request.agentId;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.translator = new AcpTranslator({
      ...context,
      cwd: request.cwd,
      budget: request.budget,
    });

    this.child = spawn(options.executable, ['acp'], {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...request.env },
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      // Buffer limitado: so vira `detail` de falha, nunca frase para o usuario.
      this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_CAP);
    });

    this.client = new AcpClient(this.child.stdin, this.child.stdout, {
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.incoming(method, params),
      onClose: () => this.closed(),
    });

    this.child.on('error', (error: Error) => {
      this.finish({
        status: 'failed',
        reason: 'Nao consegui rodar o Kimi neste computador.',
        detail: error.message,
      });
    });

    this.outcome = new Promise<AgentOutcome>((resolve) => {
      this.settle = resolve;
    });

    this.timer = setTimeout(() => {
      this.cancel('O agente passou do tempo combinado.');
    }, request.budget.maxDurationMs);

    void this.converse();
  }

  [Symbol.asyncIterator](): AsyncIterator<AnyEventDraft> {
    return this.queue[Symbol.asyncIterator]();
  }

  /** Handshake, sessao e o prompt. Tudo que falhar aqui vira desfecho, nao excecao. */
  private async converse(): Promise<void> {
    try {
      await this.client.request('initialize', {
        protocolVersion: 1,
        // Recusamos emprestar filesystem e terminal: o Kimi usa os proprios, e
        // o adaptador nao precisa implementar nenhum dos dois.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      const created = await this.client.request('session/new', {
        cwd: this.request.cwd,
        mcpServers: [],
      });
      const sessionId = readSessionId(created);
      if (sessionId === null) throw new Error('a CLI nao devolveu uma sessao');
      this.sessionId = sessionId;
      this.emit(...this.translator.start(sessionId, this.request.cwd));

      const answered = await this.client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: this.buildPrompt() }],
      });
      this.done(readStopReason(answered));
    } catch (error) {
      if (this.finished) return;
      this.finish({
        status: 'failed',
        reason: 'O Kimi parou antes de terminar.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildPrompt(): string {
    const parts = [this.request.prompt];
    if (this.request.contracts.length > 0) {
      parts.push('', 'Combinados que valem para esta tarefa:', ...this.request.contracts);
    }
    if (this.request.allowedPaths.length > 0) {
      parts.push('', `Mexa apenas em: ${this.request.allowedPaths.join(', ')}.`);
    }
    return parts.join('\n');
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'session/update') return;

    const envelope = params as { readonly update?: unknown };
    const parsed = sessionUpdateSchema.safeParse(envelope?.update);
    if (!parsed.success) return;

    this.emit(...this.translator.update(parsed.data));

    if (this.translator.turnsExceeded()) {
      this.emit(
        draft('budget.exceeded', {
          agentId: this.agentId,
          kind: 'turns',
          used: this.translator.usedTurns,
          limit: this.request.budget.maxTurns,
        }),
      );
      this.cancel('O agente passou do numero de tentativas combinado.');
    }
  }

  /**
   * Pedido do agente para nos. `session/request_permission` e o unico que
   * atendemos: qualquer outro e recusado, e e assim que o Kimi descobre que nao
   * emprestamos filesystem nem terminal.
   */
  private incoming(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      return Promise.reject(new Error(`metodo ${method} nao suportado`));
    }

    const parsed = requestPermissionParamsSchema.safeParse(params);
    if (!parsed.success) return Promise.reject(new Error('pedido de permissao malformado'));

    const { toolCall, options } = parsed.data;
    const decision = decidePermission(
      {
        toolName: toolCall.title ?? toolCall.kind ?? 'ferramenta',
        input: toolCall.rawInput ?? {},
        requiresUserInteraction: false,
        ...(toolKind(toolCall.kind) === undefined ? {} : { kind: toolKind(toolCall.kind) as ToolKind }),
        paths: pathsOf(toolCall),
      },
      this.request.cwd,
    );

    if (decision.kind === 'allow') {
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: pick(options, true) } });
    }

    // Escalonamento: o agente fica parado nesta promise ate o humano responder.
    return new Promise<unknown>((resolve) => {
      const questionId = newQuestionId();
      this.pending = { questionId, options, decision, resolve };

      this.emit(
        ...this.translator.transition('blocked', decision.question),
        draft('human.question_raised', {
          questionId,
          question: decision.question,
          context: decision.context,
          cause: decision.cause,
          askedBy: this.agentId,
          ...(this.request.taskId === undefined ? {} : { taskId: this.request.taskId }),
          options: [...decision.options],
          allowFreeText: decision.allowFreeText,
        }),
      );
    });
  }

  answer(answer: string, optionId?: string): void {
    const waiting = this.pending;
    if (waiting === null) return;
    this.pending = null;

    this.emit(
      draft('human.answered', {
        questionId: waiting.questionId,
        answer,
        ...(optionId === undefined ? {} : { optionId }),
      }),
      ...this.translator.transition('working', 'Retomando com a resposta'),
    );

    const allowed = optionId !== 'deny';
    waiting.resolve({ outcome: { outcome: 'selected', optionId: pick(waiting.options, allowed) } });
  }

  cancel(reason: string): void {
    if (this.finished) return;
    this.cancelReason = reason;

    if (this.sessionId !== null) this.client.notify('session/cancel', { sessionId: this.sessionId });
    // Escada: o cancelamento educado primeiro, o sinal depois, a forca por ultimo.
    setTimeout(() => {
      if (!this.finished) this.child.kill('SIGTERM');
      setTimeout(() => {
        if (!this.finished) this.child.kill('SIGKILL');
      }, this.killGraceMs);
    }, this.killGraceMs);
  }

  private done(reason: StopReason | null): void {
    if (this.finished) return;

    if (reason === 'cancelled' || this.cancelReason !== null) {
      this.emit(...this.translator.finish('cancelled', this.cancelReason ?? 'A execucao foi interrompida.'));
      this.finish({ status: 'cancelled', reason: this.cancelReason ?? 'A execucao foi interrompida.' });
      return;
    }

    const summary = this.lastMessage.trim().length > 0 ? this.lastMessage.trim() : 'O agente terminou.';
    if (reason === 'end_turn') {
      this.emit(...this.translator.finish('end_turn', summary));
      this.finish({
        status: 'completed',
        summary,
        turns: this.translator.usedTurns,
        ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
      });
      return;
    }

    const why = REASON_TEXT[reason ?? 'refusal'];
    this.emit(...this.translator.finish(reason ?? 'refusal', why));
    this.finish({ status: 'failed', reason: why });
  }

  /** O processo fechou. Sem motivo de parada registrado, e queda de verdade. */
  private closed(): void {
    if (this.finished) return;
    if (this.cancelReason !== null) {
      this.done('cancelled');
      return;
    }
    this.finish({
      status: 'failed',
      reason: 'O Kimi encerrou antes de terminar a tarefa.',
      ...(this.stderr.trim().length > 0 ? { detail: this.stderr.trim() } : {}),
    });
  }

  private emit(...events: AnyEventDraft[]): void {
    for (const event of events) {
      if (event.type === 'agent.message') this.lastMessage = event.payload.summary;
      this.queue.push(event);
    }
  }

  private finish(outcome: AgentOutcome): void {
    if (this.finished) return;
    this.finished = true;

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;

    this.queue.push(
      draft('agent.despawned', { agentId: this.agentId, reason: despawnReason(outcome) }),
    );
    this.settle(outcome);
    this.queue.close();
    this.client.close();
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

const REASON_TEXT: Record<StopReason, string> = {
  end_turn: 'O agente terminou.',
  cancelled: 'A execucao foi interrompida.',
  max_tokens: 'O agente chegou no limite de tamanho da conversa e parou.',
  max_turn_requests: 'O agente chegou no limite de tentativas e parou.',
  refusal: 'O agente recusou continuar com esta tarefa.',
};

const despawnReason = (outcome: AgentOutcome): 'finished' | 'cancelled' | 'crashed' | 'budget' => {
  switch (outcome.status) {
    case 'completed':
      return 'finished';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'finished';
    case 'failed':
      return 'crashed';
  }
};

/** O id da opcao e do Kimi, nao nosso: sai sempre do pedido que ele mandou. */
function pick(options: readonly PermissionOption[], allow: boolean): string {
  const wanted = allow ? 'allow_once' : 'reject_once';
  const fallback = allow ? 'allow_always' : 'reject_always';
  const found =
    options.find((option) => option.kind === wanted) ??
    options.find((option) => option.kind === fallback) ??
    options[0];
  return found?.optionId ?? 'reject';
}

function pathsOf(toolCall: {
  readonly locations?: readonly { readonly path: string }[] | undefined;
  readonly content?: readonly unknown[] | undefined;
}): string[] {
  const fromLocations = (toolCall.locations ?? []).map((location) => location.path);
  const fromDiff = (toolCall.content ?? []).flatMap((block) => {
    const record = block as { type?: unknown; path?: unknown };
    return record.type === 'diff' && typeof record.path === 'string' ? [record.path] : [];
  });
  return [...new Set([...fromLocations, ...fromDiff])];
}

function readSessionId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>)['sessionId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readStopReason(value: unknown): StopReason | null {
  if (typeof value !== 'object' || value === null) return null;
  const parsed = stopReasonSchema.safeParse((value as Record<string, unknown>)['stopReason']);
  return parsed.success ? parsed.data : null;
}
