import type { AgentId, Plan, RoleId, Subtask } from '@hive/protocol';
import type { Worktree } from '@hive/agents';

export interface ActiveAgent {
  readonly agentId: AgentId;
  readonly role: RoleId;
  readonly worktree: Worktree;
  readonly currentTask: Subtask['id'] | null;
}

export interface AssignmentRequest {
  readonly plan: Plan;
  readonly completed: ReadonlySet<Subtask['id']>;
  readonly active: readonly ActiveAgent[];
  /** Quantos agentes podem trabalhar ao mesmo tempo. */
  readonly maxParallel: number;
}

export interface Assignment {
  readonly subtask: Subtask;
  readonly agentId: AgentId;
  /** Quem delegou. Vai direto para o payload de `task.assigned`. */
  readonly assignedBy: AgentId;
}

/**
 * Escolhe o que roda agora e quem executa. So considera subtask cujas
 * dependencias fecharam e cujos contratos de entrada ja foram publicados.
 */
export interface Assigner {
  next(request: AssignmentRequest): readonly Assignment[];
}
