import { z } from 'zod';
import { agentId, questionId, taskId } from '../ids';

/**
 * Por que o sistema parou. Uma pergunta de produto e um pedido de permissao
 * chegam pelo mesmo canal da CLI, mas se leem de formas diferentes para quem
 * nao le codigo -- e o 3D anima cada uma de um jeito.
 */
export const blockCauseSchema = z.enum([
  'agent_asked',
  'permission',
  'gate_failed',
  'budget',
  'merge_conflict',
  'agent_crashed',
  /** O gerente dividiu o trabalho e espera o aval antes de soltar os agentes. */
  'plan_review',
]);
export type BlockCause = z.infer<typeof blockCauseSchema>;

export const humanEventPayloads = {
  /**
   * O sistema parou e precisa de uma decisao. A pergunta e respondivel por
   * quem nao le codigo: sem jargao, sem stack trace, com opcoes quando possivel.
   */
  'human.question_raised': z.object({
    questionId,
    question: z.string().min(1),
    /** Por que estamos perguntando, em uma frase. */
    context: z.string().min(1),
    cause: blockCauseSchema.default('agent_asked'),
    askedBy: agentId.optional(),
    taskId: taskId.optional(),
    /**
     * Num pedido de permissao os ids sao `allow` e `deny`: a decisao volta em
     * `human.answered.optionId`, entao o contrato se descreve sozinho.
     */
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .default([]),
    /** Resposta livre e aceita alem das opcoes. */
    allowFreeText: z.boolean().default(true),
  }),
  'human.answered': z.object({
    questionId,
    answer: z.string().min(1),
    optionId: z.string().min(1).optional(),
  }),
} as const;
