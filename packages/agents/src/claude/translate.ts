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
import type { CliLine } from './cli-messages';
import { fileChangeFrom } from './patch';
import { capSummary, describeToolCall, describeToolResult } from '../tool-summary';
import type { RunUsage } from '../adapter';

export interface TranslateContext {
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
}

interface PendingCall {
  readonly tool: string;
  readonly target?: string;
}

/**
 * O nucleo do adaptador: transforma linhas da CLI em eventos do dominio.
 *
 * Nao conhece processo, pipe nem timer -- recebe uma linha ja parseada e
 * devolve os drafts que ela gera. E isso que permite testar a traducao inteira
 * contra NDJSON gravado, sem subir nenhuma CLI.
 */
export class StreamTranslator {
  private state: AgentState = 'idle';
  private readonly calls = new Map<string, PendingCall>();
  private sessionId: string | undefined;
  private spawned = false;
  private turns = 0;
  private lastSignature: string | null = null;
  private repeats = 1;
  private warnedTurns = false;
  private loopReported = false;

  constructor(private readonly context: TranslateContext) {}

  /** Sessao da CLI, quando ja conhecida. Guardada para retomar depois. */
  get session(): string | undefined {
    return this.sessionId;
  }

  get currentState(): AgentState {
    return this.state;
  }

  /** Muda o estado do agente, emitindo o evento so quando ele muda de verdade. */
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

  line(line: CliLine): AnyEventDraft[] {
    switch (line.type) {
      case 'system':
        return this.system(line);
      case 'assistant':
        return this.assistant(line);
      case 'user':
        return this.user(line);
      case 'result':
        return this.result(line);
      default:
        // `control_request`, `rate_limit_event` e o que a CLI inventar depois.
        return [];
    }
  }

  private system(line: Extract<CliLine, { type: 'system' }>): AnyEventDraft[] {
    if (line.subtype === 'init') {
      if (this.spawned) return [];
      this.spawned = true;
      const init = line;
      this.sessionId = init.session_id;
      const { agentId, role, displayName, adapter, model, cwd, taskId, title } = this.context;
      const events: AnyEventDraft[] = [
        draft('agent.spawned', {
          agentId,
          role,
          displayName,
          adapter,
          // Sem worktree nesta etapa: o agente trabalha na propria pasta e
          // `branch` fica ausente em vez de inventar um nome.
          worktreePath: cwd,
          ...(model === undefined ? {} : { model }),
          ...(init.session_id === undefined ? {} : { sessionId: init.session_id }),
        }),
      ];
      if (taskId !== undefined) {
        events.push(draft('task.started', { taskId, agentId, title }));
      }
      return events;
    }

    if (line.subtype === 'thinking_tokens') {
      return this.transition('thinking', 'Pensando no que fazer');
    }
    return [];
  }

  private assistant(line: Extract<CliLine, { type: 'assistant' }>): AnyEventDraft[] {
    // Linha de subagente: nao e o agente que estamos desenhando na sala.
    if (line.parent_tool_use_id != null) return [];

    const events: AnyEventDraft[] = [];
    const { agentId, taskId, cwd } = this.context;
    const toolBlocks = line.message.content.filter((block) => block.type === 'tool_use');
    this.turns += 1;
    events.push(...this.checkTurns());

    for (const block of line.message.content) {
      if (block.type === 'thinking') {
        events.push(...this.transition('thinking', 'Pensando no que fazer'));
      } else if (block.type === 'text' && block.text.trim().length > 0 && toolBlocks.length === 0) {
        events.push(...this.transition('talking'));
        events.push(
          draft('agent.message', {
            from: agentId,
            to: 'human',
            intent: 'inform',
            summary: capSummary(block.text.trim()),
          }),
        );
      } else if (block.type === 'tool_use') {
        events.push(...this.transition('working'));
        const described = describeToolCall(block.name, block.input, cwd);
        this.calls.set(block.id, {
          tool: block.name,
          ...(described.target === undefined ? {} : { target: described.target }),
        });
        events.push(
          draft('tool.call', {
            agentId,
            ...(taskId === undefined ? {} : { taskId }),
            callId: block.id,
            tool: block.name,
            ...(described.target === undefined ? {} : { target: described.target }),
            summary: capSummary(described.summary),
          }),
        );
        events.push(...this.checkLoop(`${block.name}:${described.target ?? ''}`));
      }
    }
    return events;
  }

  private user(line: Extract<CliLine, { type: 'user' }>): AnyEventDraft[] {
    if (line.parent_tool_use_id != null) return [];

    const events: AnyEventDraft[] = [];
    const { agentId, taskId } = this.context;

    for (const block of line.message.content) {
      if (block.type !== 'tool_result') continue;
      const call = this.calls.get(block.tool_use_id);
      this.calls.delete(block.tool_use_id);
      const tool = call?.tool ?? 'ferramenta';
      const ok = block.is_error !== true;
      const detail = typeof block.content === 'string' ? block.content : undefined;

      events.push(
        draft('tool.result', {
          agentId,
          ...(taskId === undefined ? {} : { taskId }),
          callId: block.tool_use_id,
          tool,
          ok,
          summary: capSummary(describeToolResult(tool, call?.target, ok)),
          // Saida bruta atras de um clique, nunca na frase principal.
          ...(detail === undefined || detail.length === 0 ? {} : { detail }),
        }),
      );
    }

    const change = fileChangeFrom(line.tool_use_result);
    if (change !== null) {
      events.push(
        draft('file.changed', {
          agentId,
          ...(taskId === undefined ? {} : { taskId }),
          path: this.relative(change.path),
          change: change.change,
          linesAdded: change.linesAdded,
          linesRemoved: change.linesRemoved,
        }),
      );
    }
    return events;
  }

  private result(line: Extract<CliLine, { type: 'result' }>): AnyEventDraft[] {
    const events: AnyEventDraft[] = [];
    const { agentId, taskId, budget } = this.context;
    if (line.session_id !== undefined) this.sessionId = line.session_id;

    if (line.subtype === 'error_max_turns' || line.subtype === 'error_max_budget') {
      const kind = line.subtype === 'error_max_turns' ? 'turns' : 'cost';
      events.push(
        draft('budget.exceeded', {
          agentId,
          kind,
          used: kind === 'turns' ? (line.num_turns ?? this.turns) : (line.total_cost_usd ?? 0),
          limit: kind === 'turns' ? budget.maxTurns : maxCostUsd(budget),
        }),
      );
    }

    if (taskId !== undefined) {
      const cancelled = line.terminal_reason === 'aborted_tools';
      if (line.subtype === 'success') {
        events.push(
          draft('task.completed', {
            taskId,
            agentId,
            summary: capSummary(line.result?.trim() || 'Trabalho concluido'),
          }),
        );
      } else if (!cancelled) {
        events.push(
          draft('task.failed', {
            taskId,
            agentId,
            reason: failureReason(line.subtype),
            ...(line.result === undefined ? {} : { detail: line.result }),
          }),
        );
      }
    }

    events.push(...usageEvents(line, agentId, taskId));
    events.push(...this.transition('done'));
    return events;
  }

  private checkTurns(): AnyEventDraft[] {
    const { agentId, budget } = this.context;
    const limit = budget.maxTurns;
    if (this.warnedTurns || this.turns < Math.ceil(limit * 0.8)) return [];
    this.warnedTurns = true;
    return [draft('budget.warning', { agentId, kind: 'turns', used: this.turns, limit })];
  }

  /** Estourou o orcamento de turnos? Quem cancela e a execucao, nao a traducao. */
  turnsExceeded(): boolean {
    return this.turns > this.context.budget.maxTurns;
  }

  private checkLoop(signature: string): AnyEventDraft[] {
    if (signature === this.lastSignature) {
      this.repeats += 1;
    } else {
      this.lastSignature = signature;
      this.repeats = 1;
      this.loopReported = false;
    }
    if (this.loopReported || this.repeats <= this.context.budget.maxRepeats) return [];
    this.loopReported = true;
    return [
      draft('loop.detected', {
        agentId: this.context.agentId,
        ...(this.context.taskId === undefined ? {} : { taskId: this.context.taskId }),
        signature,
        occurrences: this.repeats,
      }),
    ];
  }

  private relative(path: string): string {
    const { cwd } = this.context;
    return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  }
}

/**
 * O consumo, um evento por modelo.
 *
 * Vem de `modelUsage` e nao do `usage` somado porque uma execucao mistura
 * modelos -- a CLI usa um barato para trabalho interno -- e o total sozinho nao
 * responde a unica pergunta que interessa aqui: qual modelo vale para qual
 * passo. Sem `modelUsage` nao emitimos nada: zero se leria como "de graca".
 */
function usageEvents(
  line: Extract<CliLine, { type: 'result' }>,
  agentId: AgentId,
  taskId: TaskId | undefined,
): AnyEventDraft[] {
  if (line.modelUsage === undefined) return [];

  return Object.entries(line.modelUsage)
    .filter(([, usage]) => usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens > 0)
    .map(([id, usage]) =>
      draft('agent.usage', {
        agentId,
        ...(taskId === undefined ? {} : { taskId }),
        // O nome curto e o que alguem reconhece; o id concreto so entra quando
        // a CLI nao mandou o curto.
        model: usage.canonicalModel ?? id,
        inputTokens: Math.round(usage.inputTokens),
        outputTokens: Math.round(usage.outputTokens),
        cacheCreationTokens: Math.round(usage.cacheCreationInputTokens),
        cacheReadTokens: Math.round(usage.cacheReadInputTokens),
        costUsd: usage.costUSD,
      }),
    );
}

/** O total da execucao, para o desfecho carregar sem ninguem reler o log. */
export function totalUsage(line: Extract<CliLine, { type: 'result' }>): RunUsage | undefined {
  const { usage } = line;
  if (usage === undefined && line.total_cost_usd === undefined) return undefined;
  return {
    costUsd: line.total_cost_usd ?? 0,
    tokens: Math.round(
      (usage?.input_tokens ?? 0) +
        (usage?.output_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0),
    ),
  };
}

/** Orcamento de tempo vira teto de custo grosseiro quando a CLI so aceita dolar. */
export function maxCostUsd(budget: Budget): number {
  return Math.max(1, Math.round((budget.maxTurns / 30) * 5));
}

function failureReason(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'O agente tentou muitas vezes e parou.';
    case 'error_max_budget':
      return 'O agente chegou no limite de custo e parou.';
    default:
      return 'O agente parou antes de terminar.';
  }
}
