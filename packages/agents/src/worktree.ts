import type { AgentId } from '@office/protocol';

/**
 * Isolamento por git worktree. Cada agente ativo trabalha numa copia propria,
 * criada a partir de um branch base; dois agentes nunca compartilham diretorio.
 * A integracao e etapa explicita do gerente, nunca efeito colateral.
 *
 * Só os tipos por enquanto -- a implementacao entra junto com os adaptadores reais.
 */
export interface Worktree {
  readonly agentId: AgentId;
  /** Caminho absoluto da copia. Vira o `cwd` do subprocesso. */
  readonly path: string;
  readonly branch: string;
  /** Branch de onde a copia saiu. */
  readonly base: string;
  readonly createdAt: number;
}

export interface CreateWorktreeInput {
  readonly agentId: AgentId;
  readonly repositoryPath: string;
  readonly base: string;
  readonly branch: string;
}

export interface WorktreeDiff {
  readonly files: readonly { readonly path: string; readonly added: number; readonly removed: number }[];
  readonly commits: number;
}

export type MergeResult =
  | { readonly status: 'merged'; readonly filesChanged: number }
  | { readonly status: 'conflict'; readonly files: readonly string[] }
  | { readonly status: 'empty' };

export interface WorktreeManager {
  create(input: CreateWorktreeInput): Promise<Worktree>;
  list(repositoryPath: string): Promise<readonly Worktree[]>;
  diff(worktree: Worktree): Promise<WorktreeDiff>;
  /** Integra a worktree no branch destino. Conflito e resposta, nao excecao. */
  merge(worktree: Worktree, into: string): Promise<MergeResult>;
  remove(worktree: Worktree, options?: { readonly force?: boolean }): Promise<void>;
}
