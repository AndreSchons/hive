import { z } from 'zod';
import { agentId } from '../ids';
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
} as const;
