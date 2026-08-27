import { z } from 'zod';
import { agentId, taskId } from '../ids';

/**
 * O ciclo de vida do isolamento. Cada agente ativo trabalha numa copia propria
 * do repositorio; integrar e etapa explicita, nunca efeito colateral -- entao
 * cada passo dessa etapa deixa rastro no log.
 */
export const worktreeEventPayloads = {
  'worktree.created': z.object({
    agentId,
    taskId: taskId.optional(),
    /** Caminho absoluto da copia. Vira o `cwd` do subprocesso. */
    path: z.string().min(1),
    branch: z.string().min(1),
    /** Branch de onde a copia saiu. */
    base: z.string().min(1),
  }),
  /**
   * Dois trabalhos se cruzaram. O merge fica **em curso** no repositorio base:
   * detectar e parar e o comportamento, nunca resolver por conta propria.
   */
  'worktree.conflict': z.object({
    agentId,
    taskId: taskId.optional(),
    branch: z.string().min(1),
    into: z.string().min(1),
    /** Arquivos que os dois lados tocaram. */
    files: z.array(z.string().min(1)).min(1),
  }),
  'worktree.merged': z.object({
    agentId,
    taskId,
    branch: z.string().min(1),
    into: z.string().min(1),
    filesChanged: z.number().int().nonnegative(),
    /** Presente quando um agente desfez o conflito antes de fechar. */
    resolvedBy: agentId.optional(),
  }),
  'worktree.removed': z.object({
    agentId,
    branch: z.string().min(1),
    reason: z.enum(['merged', 'discarded']),
  }),
} as const;
