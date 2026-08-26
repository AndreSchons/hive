import { z } from 'zod';
import { agentId, questionId, taskId } from '../ids';

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
    askedBy: agentId.optional(),
    taskId: taskId.optional(),
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
