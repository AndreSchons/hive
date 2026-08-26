import { z } from 'zod';

export const runEventPayloads = {
  'run.started': z.object({
    projectPath: z.string().min(1),
    goal: z.string().min(1),
    startedBy: z.enum(['human', 'schedule', 'system']),
  }),
  'run.completed': z.object({
    summary: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    tasksCompleted: z.number().int().nonnegative(),
  }),
  'run.failed': z.object({
    /** Frase para o usuario. Nunca stack trace. */
    reason: z.string().min(1),
    /** Detalhe tecnico, exibido so sob demanda. */
    detail: z.string().optional(),
  }),
} as const;
