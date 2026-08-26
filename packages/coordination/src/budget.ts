import type { AgentId, Budget, TaskId } from '@office/protocol';

export type BudgetKind = 'turns' | 'time';

export interface BudgetUsage {
  readonly agentId: AgentId;
  readonly turns: number;
  readonly elapsedMs: number;
  /** Assinatura da ultima acao e quantas vezes seguidas ela se repetiu. */
  readonly lastSignature: string | null;
  readonly repeats: number;
}

export type BudgetVerdict =
  | { readonly status: 'ok' }
  | { readonly status: 'warning'; readonly kind: BudgetKind; readonly used: number; readonly limit: number }
  | { readonly status: 'exceeded'; readonly kind: BudgetKind; readonly used: number; readonly limit: number }
  /** Mesma acao tentada de novo: continuar as cegas nao vai resolver. */
  | { readonly status: 'looping'; readonly signature: string; readonly occurrences: number };

/**
 * Limites duros por execucao. Estourou o orcamento ou detectou repeticao, para
 * e pergunta -- nunca segue tentando.
 */
export interface BudgetTracker {
  start(agentId: AgentId, budget: Budget, taskId?: TaskId): void;
  /** Registra um turno e a assinatura da acao tentada. */
  record(agentId: AgentId, signature: string): BudgetVerdict;
  usage(agentId: AgentId): BudgetUsage | null;
  release(agentId: AgentId): void;
}
