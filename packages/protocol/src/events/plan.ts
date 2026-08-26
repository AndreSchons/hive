import { z } from 'zod';
import { agentId } from '../ids';
import { contractSchema, planSchema } from '../plan';

export const planEventPayloads = {
  /** Carrega o plano inteiro: o mundo 3D reconstroi o quadro sem consultar nada. */
  'plan.created': z.object({
    plan: planSchema,
    createdBy: agentId,
  }),
  'plan.revised': z.object({
    plan: planSchema,
    revisedBy: agentId,
    reason: z.string().min(1),
  }),
  'contract.published': z.object({
    contract: contractSchema,
    publishedBy: agentId,
    /** Subtasks que estavam esperando este contrato para poder comecar. */
    unblocks: z.array(z.string()).default([]),
  }),
} as const;
