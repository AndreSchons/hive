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
    /**
     * O total da execucao, somado dos `agent.usage`. Fica aqui para quem le o
     * fim do log saber o que custou sem precisar somar o log inteiro -- e zero
     * quando nenhuma CLI envolvida reporta consumo.
     */
    costUsd: z.number().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0),
  }),
  'run.failed': z.object({
    /** Frase para o usuario. Nunca stack trace. */
    reason: z.string().min(1),
    /** Detalhe tecnico, exibido so sob demanda. */
    detail: z.string().optional(),
  }),
} as const;
