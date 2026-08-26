import { z } from 'zod';
import { agentId, taskId } from '../ids';

/** Destino de uma mensagem: outro agente, o humano, ou a sala inteira. */
const recipient = z.union([agentId, z.literal('human'), z.literal('all')]);

export const interactionEventPayloads = {
  'agent.message': z.object({
    from: agentId,
    to: recipient,
    intent: z.enum(['inform', 'request', 'answer', 'review', 'warn']),
    /** Uma frase. O 3D exibe isso num balao, entao nao cabe texto longo. */
    summary: z.string().min(1).max(280),
  }),
  'agent.handoff': z.object({
    from: agentId,
    to: agentId,
    taskId,
    /** O que muda de maos: contrato, branch, arquivo. */
    artifact: z.string().min(1),
  }),
} as const;
