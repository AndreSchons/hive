import { z } from 'zod';
import { agentId, taskId } from '../ids';
import { adapterId, agentStateSchema, roleId } from '../roles';

export const agentEventPayloads = {
  'agent.spawned': z.object({
    agentId,
    role: roleId,
    /** Nome exibido no escritorio 3D. */
    displayName: z.string().min(1),
    adapter: adapterId,
    model: z.string().optional(),
    /** Diretorio isolado do agente. Dois agentes nunca compartilham o mesmo. */
    worktreePath: z.string().min(1),
    /** Ausente enquanto o agente roda direto na pasta, sem worktree propria. */
    branch: z.string().min(1).optional(),
    /** Sessao da CLI. E a chave para retomar esta mesma conversa depois. */
    sessionId: z.string().min(1).optional(),
  }),
  'agent.state_changed': z.object({
    agentId,
    from: agentStateSchema,
    to: agentStateSchema,
    /** Frase curta para balao de fala / tooltip. */
    reason: z.string().optional(),
  }),
  'agent.despawned': z.object({
    agentId,
    reason: z.enum(['finished', 'cancelled', 'crashed', 'budget']),
  }),
  /**
   * O que este agente consumiu, **um evento por modelo**. Uma execucao mistura
   * modelos (a CLI usa um barato para tarefa interna), e somar tudo num numero
   * so esconde de onde o dinheiro saiu -- que e justamente o que se quer ver
   * para decidir qual modelo vale para qual passo.
   *
   * Nem toda CLI reporta consumo. Quem nao reporta **nao emite**: zero se le
   * como "foi de graca", e isso seria mentira.
   */
  'agent.usage': z.object({
    agentId,
    taskId: taskId.optional(),
    /** Nome canonico do modelo, como a propria CLI reportou. */
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    /**
     * Escrever no cache custa mais caro que ler dele, e e o que uma sessao fria
     * paga. Separado de proposito: e o numero que explica por que dividir o
     * trabalho em muitas sessoes curtas sai caro.
     */
    cacheCreationTokens: z.number().int().nonnegative().default(0),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
  }),
} as const;
