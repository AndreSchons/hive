import { z } from 'zod';
import { agentId, gateId, taskId } from '../ids';
import { gateKindSchema } from '../plan';

export const gateEventPayloads = {
  'gate.started': z.object({
    gateId,
    taskId,
    agentId,
    kind: gateKindSchema,
    command: z.string().min(1),
  }),
  'gate.passed': z.object({
    gateId,
    taskId,
    agentId,
    kind: gateKindSchema,
    durationMs: z.number().int().nonnegative(),
  }),
  'gate.failed': z.object({
    gateId,
    taskId,
    agentId,
    kind: gateKindSchema,
    exitCode: z.number().int(),
    /** Resumo legivel. A saida bruta fica em `detail`. */
    summary: z.string().min(1),
    detail: z.string().optional(),
  }),
} as const;
