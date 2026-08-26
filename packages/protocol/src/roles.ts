import { z } from 'zod';

/**
 * Papeis sao configuracao, nunca constantes do codigo. O sistema nao conhece
 * "gerente" ou "frontend": conhece a forma de uma definicao de papel.
 */
export const roleId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, 'roleId deve ser kebab-case iniciando por letra')
  .brand<'RoleId'>();
export type RoleId = z.infer<typeof roleId>;

/** Identificador do adaptador de CLI (`claude`, `kimi`, `mock`, ...). */
export const adapterId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, 'adapterId deve ser kebab-case iniciando por letra')
  .brand<'AdapterId'>();
export type AdapterId = z.infer<typeof adapterId>;

export const agentStateSchema = z.enum([
  'idle',
  'thinking',
  'working',
  'blocked',
  'talking',
  'done',
]);
export type AgentState = z.infer<typeof agentStateSchema>;

export const roleDefinitionSchema = z.object({
  id: roleId,
  /** Rotulo exibido ao usuario que nao le codigo. */
  title: z.string().min(1),
  description: z.string().default(''),
  /** Qual CLI executa este papel. */
  adapter: adapterId,
  /** Alias de modelo repassado a CLI. Ausente = default da propria CLI. */
  model: z.string().min(1).optional(),
  /** Papel com autoridade para planejar, delegar e integrar. */
  canDelegate: z.boolean().default(false),
});
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

export const rosterSchema = z
  .array(roleDefinitionSchema)
  .min(1)
  .superRefine((roles, ctx) => {
    const seen = new Set<string>();
    for (const [index, role] of roles.entries()) {
      if (seen.has(role.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `papel duplicado: ${role.id}`,
        });
      }
      seen.add(role.id);
    }
    if (!roles.some((role) => role.canDelegate)) {
      ctx.addIssue({ code: 'custom', message: 'o roster precisa de ao menos um papel com canDelegate' });
    }
  });
export type Roster = z.infer<typeof rosterSchema>;
