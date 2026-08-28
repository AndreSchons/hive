import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  draft,
  newQuestionId,
  type AnyEventDraft,
  type QuestionId,
} from '@office/protocol';
import type { AgentOutcome, AgentRun, AgentRunRequest } from '../adapter';
import { AsyncQueue } from '../process/async-queue';
import { LineSplitter, parseLine } from '../process/stream-json';
import { parseCliLine, type CliLine } from './cli-messages';
import { decidePermission, type PermissionDecision } from '../permission';
import { StreamTranslator, maxCostUsd, type TranslateContext } from './translate';

export interface ClaudeRunOptions {
  readonly executable: string;
  /** Espera antes de escalar de interrupt para SIGTERM, e de SIGTERM para SIGKILL. */
  readonly killGraceMs?: number;
}

/** O que ficou pendente enquanto o agente espera o humano. */
interface PendingAsk {
  readonly requestId: string;
  readonly questionId: QuestionId;
  readonly decision: Extract<PermissionDecision, { kind: 'escalate' }>;
}

const STDERR_CAP = 8_000;

/**
 * Uma execucao da CLI do Claude Code.
 *
 * O processo fala NDJSON nos dois sentidos: eventos saem pelo stdout, e as
 * respostas de permissao entram pelo stdin. Quando a CLI pede autorizacao ela
 * **suspende o agente** ate receber a resposta -- e isso que da um sinal de
 * bloqueio de verdade, em vez de adivinhado.
 */
export class ClaudeRun implements AgentRun {
  readonly agentId;
  readonly outcome: Promise<AgentOutcome>;

  private readonly queue = new AsyncQueue<AnyEventDraft>();
  private readonly translator: StreamTranslator;
  private readonly splitter = new LineSplitter();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly killGraceMs: number;

  private settle: (outcome: AgentOutcome) => void = () => {};
  private finished = false;
  private pending: PendingAsk | null = null;
  private stderr = '';
  private sawResult = false;
  private lastResult: {
    subtype: string;
    terminal: string | null;
    turns: number;
    /** Texto final da CLI, inteiro. E por aqui que um plano em JSON volta. */
    text: string | null;
  } | null = null;
  private cancelReason: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private exitGuard: NodeJS.Timeout | null = null;

  constructor(
    private readonly request: AgentRunRequest,
    context: Omit<TranslateContext, 'budget' | 'cwd'>,
    options: ClaudeRunOptions,
  ) {
    this.agentId = request.agentId;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.translator = new StreamTranslator({
      ...context,
      cwd: request.cwd,
      budget: request.budget,
    });

    this.outcome = new Promise<AgentOutcome>((resolve) => {
      this.settle = resolve;
    });

    this.child = spawn(options.executable, this.args(), {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...request.env },
    });

    this.wire();
    this.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: this.fullPrompt() }] },
    });

    this.timer = setTimeout(() => {
      this.cancel('O agente passou do tempo combinado.');
    }, request.budget.maxDurationMs);
    this.timer.unref?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<AnyEventDraft> {
    return this.queue[Symbol.asyncIterator]();
  }

  answer(answer: string, optionId?: string): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;

    this.emit(
      draft('human.answered', {
        questionId: pending.questionId,
        answer,
        ...(optionId === undefined ? {} : { optionId }),
      }),
    );

    const { decision } = pending;
    if (decision.ask !== undefined) {
      // Pergunta de produto: a resposta volta no proprio input da ferramenta,
      // num mapa chaveado pelo **texto** da pergunta. O input original vai
      // inteiro junto: a ferramenta valida os campos dela de novo.
      const original = decision.ask.input;
      const base = typeof original === 'object' && original !== null ? original : {};
      this.respond(pending.requestId, {
        behavior: 'allow',
        updatedInput: { ...base, answers: { [decision.ask.questionText]: optionId ?? answer } },
      });
    } else if (optionId === 'allow') {
      this.respond(pending.requestId, { behavior: 'allow' });
    } else {
      this.respond(pending.requestId, { behavior: 'deny', message: answer });
    }

    this.emit(...this.translator.transition('working', 'Retomando com a sua resposta'));
  }

  cancel(reason: string): void {
    if (this.finished || this.cancelReason !== null) return;
    this.cancelReason = reason;

    // Escada: pedir para parar, depois pedir com mais firmeza, depois desistir.
    this.send({ type: 'control_request', request_id: 'cancel', request: { subtype: 'interrupt' } });
    const term = setTimeout(() => {
      this.child.kill('SIGTERM');
      const kill = setTimeout(() => this.child.kill('SIGKILL'), this.killGraceMs);
      kill.unref?.();
    }, this.killGraceMs);
    term.unref?.();
  }

  private args(): string[] {
    const { model, sessionId, budget } = this.request;
    return [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // Sem esta flag a CLI decide sozinha e so avisa depois: e ela que faz o
      // pedido de permissao chegar ate nos com o agente parado esperando.
      '--permission-prompt-tool',
      'stdio',
      '--max-budget-usd',
      String(maxCostUsd(budget)),
      ...(model === undefined ? [] : ['--model', model]),
      ...(sessionId === undefined ? [] : ['--resume', sessionId]),
    ];
  }

  private fullPrompt(): string {
    const { prompt, contracts, allowedPaths } = this.request;
    const parts = [prompt];
    if (contracts.length > 0) {
      parts.push(`\nContratos que valem para este trabalho:\n${contracts.join('\n\n')}`);
    }
    if (allowedPaths.length > 0) {
      parts.push(`\nMexa apenas nestas areas: ${allowedPaths.join(', ')}`);
    }
    return parts.join('\n');
  }

  private wire(): void {
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      for (const raw of this.splitter.push(chunk)) this.consume(raw);
    });
    this.child.stdout.on('end', () => {
      for (const raw of this.splitter.flush()) this.consume(raw);
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      if (this.stderr.length < STDERR_CAP) this.stderr += chunk;
    });

    this.child.on('error', (error: Error) => {
      this.finish({
        status: 'failed',
        reason: 'Nao consegui rodar o Claude Code nesta maquina.',
        detail: error.message,
      });
    });

    this.child.on('close', (code) => this.close(code));
  }

  private consume(raw: string): void {
    const parsed = parseLine(raw);
    // A CLI mistura JSON com aviso em texto puro; linha solta nao derruba nada.
    if (parsed.kind !== 'json') return;
    const line = parseCliLine(parsed.value);
    if (line === null) return;

    if (line.type === 'control_request') {
      this.permission(line);
      return;
    }
    const isResult = line.type === 'result';
    if (isResult && line.type === 'result') {
      this.sawResult = true;
      this.lastResult = {
        subtype: line.subtype,
        terminal: line.terminal_reason ?? null,
        turns: line.num_turns ?? 0,
        text: line.result?.trim() || null,
      };
    }

    this.emit(...this.translator.line(line));

    // Enquanto o stdin estiver aberto a CLI fica esperando outro turno, entao
    // ela nunca sai e a execucao nunca fecha. O `result` e o fim do trabalho:
    // e aqui que paramos de falar com ela.
    if (isResult) this.endInput();

    if (this.translator.turnsExceeded()) {
      this.cancel('O agente passou do numero de tentativas combinado.');
    }
  }

  /** Fecha a entrada e garante que a execucao termina mesmo se o `close` sumir. */
  private endInput(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.exitGuard !== null) return;
    this.exitGuard = setTimeout(() => this.close(null), Math.max(this.killGraceMs, 1_000));
    this.exitGuard.unref?.();
  }

  private permission(line: Extract<CliLine, { type: 'control_request' }>): void {
    const { request_id, request } = line;
    if (request.subtype !== 'can_use_tool' || request.tool_name === undefined) return;

    const decision = decidePermission(
      {
        toolName: request.tool_name,
        input: request.input,
        requiresUserInteraction: request.requires_user_interaction === true,
      },
      this.request.cwd,
      { readOnly: this.request.readOnly === true },
    );

    if (decision.kind === 'allow') {
      this.respond(request_id, { behavior: 'allow' });
      return;
    }

    const questionId = newQuestionId();
    this.pending = { requestId: request_id, questionId, decision };
    this.emit(...this.translator.transition('blocked', decision.question));
    this.emit(
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
  }

  private respond(requestId: string, response: Record<string, unknown>): void {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  private send(message: unknown): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private emit(...events: AnyEventDraft[]): void {
    for (const event of events) this.queue.push(event);
  }

  private close(code: number | null): void {
    if (this.finished) return;

    if (this.cancelReason !== null) {
      this.finish({ status: 'cancelled', reason: this.cancelReason });
      return;
    }

    if (!this.sawResult) {
      // Morreu sem dizer como acabou: ai sim e queda.
      this.finish({
        status: 'failed',
        reason: 'O Claude Code encerrou sem terminar o trabalho.',
        ...(this.stderr.trim().length > 0 ? { detail: this.stderr.trim() } : {}),
        ...(code === null ? {} : { exitCode: code }),
      });
      return;
    }

    const result = this.lastResult;
    if (result === null || result.subtype === 'success') {
      this.finish({
        status: 'completed',
        // O texto final vai inteiro: quem chamou pode estar esperando JSON, e
        // cortar aqui deixaria o planner sem canal de saida. Quem resume para o
        // usuario e o `translate`, que tem o limite de 280 do evento.
        summary: result?.text ?? 'Trabalho concluido',
        turns: result?.turns ?? 0,
        ...(this.translator.session === undefined ? {} : { sessionId: this.translator.session }),
      });
      return;
    }

    // Cancelamento tambem chega como `error_during_execution` com exit 1: quem
    // separa queda de parada pedida e o `terminal_reason`.
    if (result.terminal === 'aborted_tools') {
      this.finish({ status: 'cancelled', reason: this.cancelReason ?? 'A execucao foi interrompida.' });
      return;
    }

    this.finish({
      status: 'failed',
      reason: 'O agente parou antes de terminar.',
      ...(this.stderr.trim().length > 0 ? { detail: this.stderr.trim() } : {}),
      ...(code === null ? {} : { exitCode: code }),
    });
  }

  /** Idempotente: o desfecho resolve uma vez so e a fila sempre fecha. */
  private finish(outcome: AgentOutcome): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.exitGuard !== null) clearTimeout(this.exitGuard);

    this.emit(...this.translator.transition('done'));
    this.emit(draft('agent.despawned', { agentId: this.agentId, reason: despawnReason(outcome) }));

    this.settle(outcome);
    this.queue.close();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }
}

function despawnReason(outcome: AgentOutcome): 'finished' | 'cancelled' | 'crashed' | 'budget' {
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
}
