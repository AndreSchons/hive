import type { AgentId, QuestionId, TaskId } from '@office/protocol';
import type { BudgetVerdict } from './budget';
import type { GateResult } from './gate-runner';

/** Por que a execucao parou. Determina o texto da pergunta. */
export type BlockCause =
  | { readonly kind: 'agent_asked'; readonly question: string; readonly context: string }
  | { readonly kind: 'gate_failed'; readonly result: Extract<GateResult, { status: 'failed' }> }
  | { readonly kind: 'budget'; readonly verdict: BudgetVerdict }
  | { readonly kind: 'merge_conflict'; readonly files: readonly string[] }
  | { readonly kind: 'agent_crashed'; readonly reason: string; readonly detail?: string };

export interface EscalationRequest {
  readonly agentId: AgentId;
  readonly taskId?: TaskId;
  readonly cause: BlockCause;
}

/**
 * Uma pergunta que quem nao le codigo consegue responder: sem jargao, sem
 * stack trace, com opcoes concretas sempre que possivel.
 */
export interface HumanQuestion {
  readonly questionId: QuestionId;
  readonly question: string;
  /** Por que estamos perguntando, em uma frase. */
  readonly context: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly allowFreeText: boolean;
}

export type EscalationDecision =
  /** Da para resolver sozinho: tenta de novo com esta instrucao extra. */
  | { readonly action: 'retry'; readonly guidance: string }
  /** Para tudo e pergunta. */
  | { readonly action: 'ask'; readonly question: HumanQuestion }
  /** Sem saida: encerra a execucao e explica. */
  | { readonly action: 'abort'; readonly reason: string };

/**
 * Escalonamento e a experiencia principal do produto, nao um caminho de erro.
 * Esta politica decide entre tentar de novo, perguntar ou desistir -- e quando
 * pergunta, traduz a causa tecnica para linguagem do usuario.
 */
export interface EscalationPolicy {
  decide(request: EscalationRequest): EscalationDecision;
}
