import type { AnyEventDraft, ProjectRef, RunId, Roster } from '@hive/protocol';
import type { AdapterRegistry } from '@hive/agents';
import type { Assigner } from './assigner';
import type { BudgetTracker } from './budget';
import type { EscalationPolicy } from './escalation';
import type { GateRunner } from './gate-runner';
import type { Planner } from './planner';

/** Tudo que o ciclo de coordenacao precisa, injetado de fora. */
export interface OrchestratorDeps {
  readonly planner: Planner;
  readonly assigner: Assigner;
  readonly gateRunner: GateRunner;
  readonly escalation: EscalationPolicy;
  readonly budget: BudgetTracker;
  readonly adapters: AdapterRegistry;
  readonly roster: Roster;
  /**
   * Unica saida do orquestrador. Ele nao escreve no banco nem fala com a
   * janela: emite eventos e alguem decide o que fazer com eles.
   */
  readonly emit: (event: AnyEventDraft) => void;
}

export interface StartRunInput {
  readonly runId: RunId;
  readonly project: ProjectRef;
  readonly goal: string;
  readonly maxParallel: number;
}

export interface RunHandle {
  readonly runId: RunId;
  /** Entrega a resposta do humano ao agente que estava travado. */
  answer(questionId: string, answer: string): void;
  cancel(reason: string): void;
  readonly done: Promise<void>;
}

/**
 * O gerente do ponto de vista do sistema: planeja, delega, roda os portoes,
 * integra o que passou e escala o que travou. Nao conhece camera, mesa nem
 * animacao -- so emite eventos.
 */
export interface Orchestrator {
  start(input: StartRunInput): RunHandle;
}
