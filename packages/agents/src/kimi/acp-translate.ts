import { existsSync } from 'node:fs';
import {
  draft,
  type AdapterId,
  type AgentId,
  type AgentState,
  type AnyEventDraft,
  type Budget,
  type RoleId,
  type TaskId,
} from '@office/protocol';
import { capSummary, describeToolCall, describeToolResult } from '../tool-summary';
import type { ContentBlock, SessionUpdate, StopReason } from './acp-messages';

export interface KimiTranslateContext {
  readonly agentId: AgentId;
  readonly role: RoleId;
  readonly displayName: string;
  readonly adapter: AdapterId;
  readonly taskId?: TaskId;
  readonly model?: string;
  /** Pasta onde o processo roda. Usada para encurtar caminhos absolutos. */
  readonly cwd: string;
  readonly budget: Budget;
  readonly title: string;
  /**
   * O arquivo ja existia? Injetado porque o stream do Kimi **nao distingue**
   * criar de sobrescrever: num `Write` ele nao manda bloco de diff, so o
   * conteudo novo. Perguntar ao disco antes da escrita e o unico jeito honesto
   * de saber, e deixar isso injetavel mantem a traducao testavel sem disco.
   */
  readonly exists?: (path: string) => boolean;
}

interface PendingCall {
  readonly tool: string;
  target?: string;
  /** Trecho trocado, quando o Kimi manda bloco de diff (`Edit` manda, `Write` nao). */
  diff?: { readonly oldText: string | null; readonly newText: string };
  /** Conteudo inteiro, quando so temos `rawInput` (`Write`). */
  written?: string;
  existedBefore?: boolean;
  reported?: boolean;
}

const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
};

const rawPath = (raw: unknown): string | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)['path'];
  return typeof value === 'string' ? value : undefined;
};

const rawContent = (raw: unknown): string | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)['content'];
  return typeof value === 'string' ? value : undefined;
};

/**
 * O nucleo do adaptador do Kimi: transforma atualizacoes do ACP em eventos do
 * dominio. Nao conhece socket, processo nem timer -- recebe uma atualizacao ja
 * parseada e devolve os drafts que ela gera, entao a traducao inteira e
 * testavel contra frames gravadas sem subir CLI nenhuma.
 */
export class AcpTranslator {
  private state: AgentState = 'idle';
  private readonly calls = new Map<string, PendingCall>();
  /** Caminhos distintos que mudaram. Chamada de ferramenta nao e arquivo. */
  private readonly touched = new Set<string>();
  private spawned = false;
  private turns = 0;
  private lastSignature: string | null = null;
  private repeats = 1;
  private warnedTurns = false;
  private loopReported = false;

  constructor(private readonly context: KimiTranslateContext) {}

  get currentState(): AgentState {
    return this.state;
  }

  private fileExists(path: string): boolean {
    return (this.context.exists ?? existsSync)(path);
  }

  transition(to: AgentState, reason?: string): AnyEventDraft[] {
    if (this.state === to) return [];
    const from = this.state;
    this.state = to;
    return [
      draft('agent.state_changed', {
        agentId: this.context.agentId,
        from,
        to,
        ...(reason === undefined ? {} : { reason }),
      }),
    ];
  }

  /** A sessao existe: o agente entrou no escritorio e a task comecou. */
  start(sessionId: string, worktreePath: string, branch?: string): AnyEventDraft[] {
    if (this.spawned) return [];
    this.spawned = true;

    const events: AnyEventDraft[] = [
      draft('agent.spawned', {
        agentId: this.context.agentId,
        role: this.context.role,
        displayName: this.context.displayName,
        adapter: this.context.adapter,
        worktreePath,
        sessionId,
        ...(branch === undefined ? {} : { branch }),
        ...(this.context.model === undefined ? {} : { model: this.context.model }),
      }),
    ];
    if (this.context.taskId !== undefined) {
      events.push(
        draft('task.started', {
          taskId: this.context.taskId,
          agentId: this.context.agentId,
          title: this.context.title,
        }),
      );
    }
    return events;
  }

  update(update: SessionUpdate): AnyEventDraft[] {
    switch (update.sessionUpdate) {
      // Diferente do Claude, o Kimi entrega o pensamento em texto aberto. Nao
      // usamos o conteudo: saber *que* pensou basta, e citar o raciocinio na
      // interface seria ruido para quem nao le codigo.
      case 'agent_thought_chunk':
        return this.transition('thinking');
      case 'agent_message_chunk':
        return this.transition('talking');
      case 'tool_call':
        return this.toolCall(update);
      case 'tool_call_update':
        return this.toolUpdate(update);
      case 'plan':
        return this.plan(update);
      case 'other':
        return [];
    }
  }

  private plan(update: Extract<SessionUpdate, { sessionUpdate: 'plan' }>): AnyEventDraft[] {
    const doing = update.entries.find((entry) => entry.status === 'in_progress');
    if (doing === undefined || this.context.taskId === undefined) return [];

    const done = update.entries.filter((entry) => entry.status === 'completed').length;
    return [
      draft('task.progress', {
        taskId: this.context.taskId,
        agentId: this.context.agentId,
        note: capSummary(doing.content),
        ...(update.entries.length > 0 ? { ratio: done / update.entries.length } : {}),
      }),
    ];
  }

  private toolCall(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  ): AnyEventDraft[] {
    // Na frame de abertura o `title` e o nome da ferramenta; nas seguintes ele
    // ja virou frase, entao e aqui que o nome tecnico e capturado.
    const tool = update.title ?? update.kind ?? 'ferramenta';
    const target = update.locations?.[0]?.path ?? rawPath(update.rawInput);
    this.calls.set(update.toolCallId, {
      tool,
      ...(target === undefined ? {} : { target }),
    });

    const described = describeToolCall(tool, update.rawInput ?? {}, this.context.cwd);
    const events = [...this.transition('working'), ...this.budgetCheck(tool, target)];
    events.push(
      draft('tool.call', {
        agentId: this.context.agentId,
        ...(this.context.taskId === undefined ? {} : { taskId: this.context.taskId }),
        callId: update.toolCallId,
        tool,
        ...(described.target === undefined ? {} : { target: described.target }),
        summary: described.summary,
      }),
    );
    return events;
  }

  private toolUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  ): AnyEventDraft[] {
    const call = this.calls.get(update.toolCallId);
    if (call === undefined) return [];

    const target = update.locations?.[0]?.path ?? rawPath(update.rawInput);
    if (target !== undefined && call.target === undefined) call.target = target;
    this.absorb(call, update.content);

    const written = rawContent(update.rawInput);
    if (written !== undefined && call.written === undefined) call.written = written;

    // O momento certo de perguntar ao disco: `in_progress` chega **antes** da
    // escrita acontecer, entao aqui o arquivo ainda esta como estava.
    if (call.target !== undefined && call.existedBefore === undefined && update.status !== 'completed') {
      call.existedBefore = this.fileExists(call.target);
    }

    if (update.status !== 'completed' && update.status !== 'failed') return [];
    if (call.reported === true) return [];
    call.reported = true;

    const ok = update.status === 'completed';
    const output = typeof update.rawOutput === 'string' ? update.rawOutput : undefined;
    const events: AnyEventDraft[] = [
      draft('tool.result', {
        agentId: this.context.agentId,
        ...(this.context.taskId === undefined ? {} : { taskId: this.context.taskId }),
        callId: update.toolCallId,
        tool: call.tool,
        ok,
        summary: capSummary(output ?? describeToolResult(call.tool, call.target, ok)),
        ...(ok || output === undefined ? {} : { detail: output }),
      }),
    ];

    const changed = ok ? this.fileChange(call) : null;
    if (changed !== null) {
      if (changed.type === 'file.changed') this.touched.add(changed.payload.path);
      events.push(changed);
    }
    return events;
  }

  /** Guarda o bloco de diff: ele chega no update de andamento, nunca no final. */
  private absorb(call: PendingCall, content: readonly ContentBlock[] | undefined): void {
    for (const block of content ?? []) {
      if (block.type !== 'diff') continue;
      call.diff = { oldText: block.oldText ?? null, newText: block.newText };
      if (call.target === undefined) call.target = block.path;
    }
  }

  private fileChange(call: PendingCall): AnyEventDraft | null {
    if (call.target === undefined) return null;

    if (call.diff !== undefined) {
      const { oldText, newText } = call.diff;
      return draft('file.changed', {
        agentId: this.context.agentId,
        ...(this.context.taskId === undefined ? {} : { taskId: this.context.taskId }),
        path: call.target,
        change: oldText === null ? 'created' : 'modified',
        linesAdded: countLines(newText),
        linesRemoved: oldText === null ? 0 : countLines(oldText),
      });
    }

    // Sem bloco de diff sobra o conteudo cru, e ai so o disco sabia se o
    // arquivo ja existia. Sobrescrita nao tem como reportar linha removida.
    if (call.written === undefined) return null;
    return draft('file.changed', {
      agentId: this.context.agentId,
      ...(this.context.taskId === undefined ? {} : { taskId: this.context.taskId }),
      path: call.target,
      change: call.existedBefore === true ? 'modified' : 'created',
      linesAdded: countLines(call.written),
      linesRemoved: 0,
    });
  }

  /**
   * O ACP nao reporta turnos nem custo, entao a chamada de ferramenta e a
   * unidade de atividade que da para medir -- e e sobre ela que o orcamento e
   * a deteccao de repeticao trabalham.
   */
  private budgetCheck(tool: string, target: string | undefined): AnyEventDraft[] {
    const events: AnyEventDraft[] = [];
    this.turns += 1;

    const signature = `${tool}:${target ?? ''}`;
    if (signature === this.lastSignature) this.repeats += 1;
    else {
      this.lastSignature = signature;
      this.repeats = 1;
    }

    if (this.repeats > this.context.budget.maxRepeats && !this.loopReported) {
      this.loopReported = true;
      events.push(
        draft('loop.detected', {
          agentId: this.context.agentId,
          ...(this.context.taskId === undefined ? {} : { taskId: this.context.taskId }),
          signature,
          occurrences: this.repeats,
        }),
      );
    }

    const { maxTurns } = this.context.budget;
    if (this.turns >= Math.floor(maxTurns * 0.8) && this.turns < maxTurns && !this.warnedTurns) {
      this.warnedTurns = true;
      events.push(
        draft('budget.warning', {
          agentId: this.context.agentId,
          kind: 'turns',
          used: this.turns,
          limit: maxTurns,
        }),
      );
    }
    return events;
  }

  turnsExceeded(): boolean {
    return this.turns >= this.context.budget.maxTurns;
  }

  get usedTurns(): number {
    return this.turns;
  }

  /** Fecha a execucao a partir do motivo de parada que o ACP devolve. */
  finish(reason: StopReason, summary: string): AnyEventDraft[] {
    const events: AnyEventDraft[] = [];

    if (reason === 'max_tokens' || reason === 'max_turn_requests') {
      events.push(
        draft('budget.exceeded', {
          agentId: this.context.agentId,
          kind: reason === 'max_tokens' ? 'cost' : 'turns',
          used: this.turns,
          limit: this.context.budget.maxTurns,
        }),
      );
    }

    if (this.context.taskId !== undefined) {
      events.push(
        reason === 'end_turn'
          ? draft('task.completed', {
              taskId: this.context.taskId,
              agentId: this.context.agentId,
              summary: capSummary(summary),
              filesChanged: this.touched.size,
            })
          : draft('task.failed', {
              taskId: this.context.taskId,
              agentId: this.context.agentId,
              reason: capSummary(summary),
            }),
      );
    }

    events.push(...this.transition('done'));
    return events;
  }
}
