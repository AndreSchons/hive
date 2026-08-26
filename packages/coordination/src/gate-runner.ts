import type { Gate, TaskId } from '@office/protocol';
import type { Worktree } from '@office/agents';

export type GateResult =
  | { readonly status: 'passed'; readonly durationMs: number }
  | {
      readonly status: 'failed';
      readonly exitCode: number;
      /** Uma frase para o usuario. A saida bruta vai em `detail`. */
      readonly summary: string;
      readonly detail: string;
      readonly durationMs: number;
    }
  | { readonly status: 'timeout'; readonly durationMs: number };

/**
 * Executa o portao de verificacao na worktree do agente. Nenhum agente aprova
 * o proprio trabalho: quem decide se a subtask esta pronta e este comando,
 * rodado por fora, e o gerente so integra o que passou.
 */
export interface GateRunner {
  run(gate: Gate, worktree: Worktree, taskId: TaskId): Promise<GateResult>;
}
