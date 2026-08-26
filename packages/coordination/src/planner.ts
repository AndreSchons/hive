import type { Plan, Roster, RunId } from '@office/protocol';

/** O que o gerente sabe sobre o repositorio antes de decompor a task. */
export interface ProjectContext {
  readonly path: string;
  /** Branch base de onde as worktrees saem. */
  readonly baseBranch: string;
  /** Comandos disponiveis no projeto, para os portoes serem reais. */
  readonly availableGates: readonly { readonly kind: string; readonly command: string }[];
}

export interface PlanRequest {
  readonly runId: RunId;
  /** A task como o usuario escreveu, em linguagem natural. */
  readonly goal: string;
  readonly roster: Roster;
  readonly project: ProjectContext;
}

export type PlanResult =
  | { readonly status: 'planned'; readonly plan: Plan }
  /** O gerente nao conseguiu decompor sem saber mais. Vira pergunta ao humano. */
  | { readonly status: 'needs_input'; readonly question: string; readonly context: string };

/**
 * Decompoe a task numa arvore de subtasks com dependencias, portoes e
 * contratos. Publicar os contratos antes de paralelizar e obrigacao do
 * planner: sem eles o merge custa mais do que o paralelismo economizou.
 */
export interface Planner {
  plan(request: PlanRequest): Promise<PlanResult>;
  /** Replaneja depois de uma falha ou de uma resposta do humano. */
  revise(plan: Plan, reason: string): Promise<PlanResult>;
}
