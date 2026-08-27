import { z } from 'zod';
import { agentId, taskId } from '../ids';

const budgetKind = z.enum(['turns', 'time', 'cost']);

export const limitEventPayloads = {
  'budget.warning': z.object({
    agentId,
    kind: budgetKind,
    used: z.number().nonnegative(),
    limit: z.number().positive(),
  }),
  'budget.exceeded': z.object({
    agentId,
    kind: budgetKind,
    used: z.number().nonnegative(),
    limit: z.number().positive(),
  }),
  'loop.detected': z.object({
    agentId,
    taskId: taskId.optional(),
    /** Assinatura da acao repetida (ferramenta + alvo normalizados). */
    signature: z.string().min(1),
    occurrences: z.number().int().min(2),
  }),
} as const;
