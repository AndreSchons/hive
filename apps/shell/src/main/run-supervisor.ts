import {
  budgetSchema,
  draft,
  newAgentId,
  newRunId,
  newTaskId,
  type AdapterId,
  type QuestionId,
  type RoleDefinition,
  type Roster,
  type RunId,
} from '@office/protocol';
import type { AdapterRegistry, AgentRun } from '@office/agents';
import type { EventStore } from '@office/store';

/**
 * Conduz uma execucao de um agente so, do comando do usuario ate o log.
 *
 * Mora no shell de proposito: `coordination` nao pode importar de `apps/`, e o
 * orquestrador de verdade -- o que planeja, divide e integra -- ainda nao
 * existe. Quando ele existir, este arquivo encolhe para uma casca em volta
 * dele; o formato dos eventos ja e o mesmo.
 */
export interface StartRunInput {
  readonly projectPath: string;
  readonly goal: string;
}

interface LiveRun {
  readonly run: AgentRun;
  readonly startedAt: number;
}

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
    'use a ferramenta AskUserQuestion em vez de escolher por conta propria --',
    'quem vai responder nao le codigo, entao pergunte em linguagem simples.',
  ].join('\n');
}

export class RunSupervisor {
  private readonly live = new Map<RunId, LiveRun>();

  constructor(
    private readonly events: EventStore,
    private readonly adapters: AdapterRegistry,
    private readonly roster: Roster,
  ) {}

  /** Papel que executa sozinho: o primeiro do roster ligado a esta CLI. */
  private soloRole(adapter: AdapterId): RoleDefinition {
    const found = this.roster.find((role) => role.adapter === adapter && !role.canDelegate);
    const fallback = this.roster.find((role) => role.adapter === adapter);
    const role = found ?? fallback;
    if (role === undefined) throw new Error(`nenhum papel no roster usa o adaptador ${adapter}`);
    return role;
  }

  async start(input: StartRunInput): Promise<RunId> {
    const adapter = this.adapters.get('claude' as AdapterId);
    if (adapter === undefined) {
      throw new Error('O adaptador do Claude Code nao esta registrado.');
    }

    // CLI ausente e situacao esperada, e vira frase para o usuario -- nunca
    // uma execucao que abre e nunca sai do lugar.
    const probe = await adapter.probe();
    if (!probe.available) throw new Error(probe.reason);

    const role = this.soloRole(adapter.id);
    const runId = this.events.createRun({ projectPath: input.projectPath, goal: input.goal });
    this.events.append(runId, {
      type: 'run.started',
      payload: { projectPath: input.projectPath, goal: input.goal, startedBy: 'human' },
    });

    const run = adapter.start({
      agentId: newAgentId(role.id),
      role: role.id,
      taskId: newTaskId(),
      cwd: input.projectPath,
      prompt: buildPrompt(input.goal),
      allowedPaths: [],
      contracts: [],
      budget: budgetSchema.parse({}),
      ...(role.model === undefined ? {} : { model: role.model }),
    });

    this.live.set(runId, { run, startedAt: Date.now() });
    void this.pump(runId, run);
    return runId;
  }

  /** Leva os eventos do adaptador para o log, que e a unica fonte da verdade. */
  private async pump(runId: RunId, run: AgentRun): Promise<void> {
    const started = this.live.get(runId)?.startedAt ?? Date.now();
    try {
      for await (const event of run) {
        this.events.append(runId, event);
      }
    } catch (error) {
      console.error('[run-supervisor] o stream do agente falhou:', error);
    }

    try {
      const outcome = await run.outcome;
      const durationMs = Date.now() - started;
      this.closeWith(runId, outcome, durationMs);
    } catch (error) {
      console.error('[run-supervisor] nao consegui fechar a execucao:', error);
    } finally {
      this.live.delete(runId);
    }
  }

  private closeWith(
    runId: RunId,
    outcome: Awaited<AgentRun['outcome']>,
    durationMs: number,
  ): void {
    switch (outcome.status) {
      case 'completed':
        this.events.closeRun(
          runId,
          draft('run.completed', { summary: outcome.summary, durationMs, tasksCompleted: 1 }),
          'completed',
        );
        return;
      case 'cancelled':
        this.events.closeRun(runId, draft('run.failed', { reason: outcome.reason }), 'cancelled');
        return;
      case 'blocked':
        // O adaptador nao encerra bloqueado: se acontecer, e bug nosso.
        this.events.closeRun(
          runId,
          draft('run.failed', { reason: 'A execucao parou esperando uma resposta que nao chegou.' }),
          'failed',
        );
        return;
      case 'failed':
        this.events.closeRun(
          runId,
          draft('run.failed', {
            reason: outcome.reason,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          }),
          'failed',
        );
    }
  }

  /** Verdadeiro quando havia mesmo uma execucao viva para receber a resposta. */
  answer(runId: RunId, _questionId: QuestionId, answer: string, optionId?: string): boolean {
    const live = this.live.get(runId);
    if (live === undefined) return false;
    live.run.answer(answer, optionId);
    return true;
  }

  cancel(runId: RunId, reason = 'Voce pediu para parar.'): boolean {
    const live = this.live.get(runId);
    if (live === undefined) return false;
    live.run.cancel(reason);
    return true;
  }

  /** Janela fechando: nao deixa subprocesso orfao rodando no computador. */
  stop(): void {
    for (const [, live] of this.live) live.run.cancel('O aplicativo foi fechado.');
    this.live.clear();
  }
}
