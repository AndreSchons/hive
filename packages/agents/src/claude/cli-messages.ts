import { z } from 'zod';

/**
 * Schemas do que a CLI do Claude Code escreve no stdout.
 *
 * Sao deliberadamente permissivos: a CLI e um programa de terceiro que evolui
 * sozinho, e um campo novo ou um tipo de linha desconhecido nao pode derrubar
 * uma execucao. Tudo que nao reconhecemos cai em `unknown` e e ignorado --
 * nunca em erro.
 */

const block = {
  thinking: z.object({
    type: z.literal('thinking'),
    /** Vem redigido: so a assinatura e real. Da para saber que pensou, nunca o que. */
    thinking: z.string().default(''),
  }),
  text: z.object({ type: z.literal('text'), text: z.string().default('') }),
  toolUse: z.object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown().optional(),
  }),
  toolResult: z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1),
    is_error: z.boolean().optional(),
    content: z.unknown().optional(),
  }),
} as const;

export const contentBlockSchema = z.union([
  block.thinking,
  block.text,
  block.toolUse,
  block.toolResult,
  // Bloco que ainda nao conhecemos vira um tipo literal proprio: sem isso o
  // compilador nao consegue estreitar a uniao pelo campo `type`.
  z.object({ type: z.string() }).transform((value) => ({ type: 'other' as const, raw: value.type })),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

const message = z.object({
  content: z.array(contentBlockSchema).default([]),
  stop_reason: z.string().nullish(),
});

export const cliLineSchema = z.union([
  z.object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    claude_code_version: z.string().optional(),
  }),
  z.object({
    type: z.literal('system'),
    subtype: z.literal('thinking_tokens'),
    estimated_tokens: z.number().optional(),
    estimated_tokens_delta: z.number().optional(),
  }),
  z
    .object({ type: z.literal('system'), subtype: z.string() })
    .transform((value) => ({ type: 'system' as const, subtype: 'other' as const, raw: value.subtype })),
  z.object({
    type: z.literal('assistant'),
    message: message.default({ content: [] }),
    session_id: z.string().optional(),
    /** Preenchido quando a linha vem de um subagente, nao do agente principal. */
    parent_tool_use_id: z.string().nullish(),
  }),
  z.object({
    type: z.literal('user'),
    message: message.default({ content: [] }),
    /** Resultado estruturado e especifico da ferramenta. Ver `patch.ts`. */
    tool_use_result: z.unknown().optional(),
    parent_tool_use_id: z.string().nullish(),
  }),
  z.object({
    type: z.literal('control_request'),
    request_id: z.string().min(1),
    request: z.object({
      subtype: z.string(),
      tool_name: z.string().optional(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      input: z.unknown().optional(),
      tool_use_id: z.string().optional(),
      /** Verdadeiro no `AskUserQuestion`: e pergunta de gente, nao permissao. */
      requires_user_interaction: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('control_response'),
    response: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean().optional(),
    stop_reason: z.string().nullish(),
    /** Separa cancelamento de queda: `aborted_tools` vs. `completed`. */
    terminal_reason: z.string().nullish(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
    total_cost_usd: z.number().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
  }),
  z.object({ type: z.string() }).transform((value) => ({ type: 'other' as const, raw: value.type })),
]);
export type CliLine = z.infer<typeof cliLineSchema>;

/** Devolve `null` para linha que nao reconhecemos, em vez de lancar. */
export function parseCliLine(value: unknown): CliLine | null {
  const parsed = cliLineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
