import { z } from 'zod';
import { agentId, taskId } from '../ids';

export const workEventPayloads = {
  'tool.call': z.object({
    agentId,
    taskId: taskId.optional(),
    /** Id da chamada na propria CLI. Pareia com o `tool.result` correspondente. */
    callId: z.string().min(1),
    /** Nome da ferramenta como a CLI reportou. */
    tool: z.string().min(1),
    target: z.string().optional(),
    summary: z.string().min(1).max(280),
  }),
  /**
   * Fecha o que `tool.call` abriu. Sem isto uma chamada e anunciada e nunca
   * resolvida: o feed nunca consegue dizer que a ferramenta falhou.
   */
  'tool.result': z.object({
    agentId,
    taskId: taskId.optional(),
    callId: z.string().min(1),
    tool: z.string().min(1),
    ok: z.boolean(),
    /** Frase para o usuario. */
    summary: z.string().min(1).max(280),
    /** Saida bruta, atras de um clique. */
    detail: z.string().optional(),
  }),
  'file.changed': z.object({
    agentId,
    taskId: taskId.optional(),
    path: z.string().min(1),
    change: z.enum(['created', 'modified', 'deleted']),
    linesAdded: z.number().int().nonnegative().default(0),
    linesRemoved: z.number().int().nonnegative().default(0),
  }),
} as const;
