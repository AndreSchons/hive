import { z } from 'zod';

/**
 * Schemas das frames do Agent Client Protocol, como o Kimi realmente as manda.
 *
 * Permissivos de proposito: o que nao reconhecemos vira `other` em vez de
 * derrubar a execucao. Uma CLI que ganha um campo novo numa atualizacao nao
 * pode quebrar o app de quem ja estava usando.
 */

const textBlock = z.object({
  type: z.literal('content'),
  content: z.object({ type: z.string(), text: z.string().optional() }),
});

/**
 * O bloco que interessa numa edicao. Medido: no `Edit` o Kimi manda `oldText` e
 * `newText` com **o trecho trocado**, nao o arquivo inteiro; no `Write` ele nao
 * manda bloco de diff nenhum -- so `rawInput.content`.
 */
const diffBlock = z.object({
  type: z.literal('diff'),
  path: z.string().min(1),
  oldText: z.string().nullish(),
  newText: z.string(),
});

/**
 * O catch-all usa `transform` para produzir um tipo literal. Sem isso o union
 * se sobrepoe a todos os membros e o TypeScript nao consegue mais estreitar --
 * a mesma armadilha que o adaptador do Claude ja tinha encontrado.
 */
const otherBlock = z
  .object({ type: z.string() })
  .transform((value) => ({ type: 'other' as const, raw: value.type }));

export const contentBlockSchema = z.union([diffBlock, textBlock, otherBlock]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const toolStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

const toolCallShape = {
  toolCallId: z.string().min(1),
  /** Na frame `tool_call` e o nome da ferramenta; no update vira frase. */
  title: z.string().optional(),
  kind: z.string().optional(),
  status: toolStatusSchema.optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  locations: z.array(z.object({ path: z.string().min(1) })).optional(),
  content: z.array(contentBlockSchema).optional(),
};

const chunk = z.object({ content: z.object({ type: z.string(), text: z.string().optional() }) });

export const sessionUpdateSchema = z.union([
  z.object({ sessionUpdate: z.literal('agent_message_chunk') }).extend(chunk.shape),
  z.object({ sessionUpdate: z.literal('agent_thought_chunk') }).extend(chunk.shape),
  z.object({ sessionUpdate: z.literal('tool_call') }).extend(toolCallShape),
  z.object({ sessionUpdate: z.literal('tool_call_update') }).extend(toolCallShape),
  z.object({
    sessionUpdate: z.literal('plan'),
    entries: z
      .array(z.object({ content: z.string(), status: z.string().optional() }))
      .default([]),
  }),
  z
    .object({ sessionUpdate: z.string() })
    .transform((value) => ({ sessionUpdate: 'other' as const, raw: value.sessionUpdate })),
]);
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

/** Opcao oferecida num pedido de permissao. Os ids sao do Kimi, nunca nossos. */
export const permissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

export const requestPermissionParamsSchema = z.object({
  sessionId: z.string().min(1),
  options: z.array(permissionOptionSchema).min(1),
  toolCall: z.object(toolCallShape),
});
export type RequestPermissionParams = z.infer<typeof requestPermissionParamsSchema>;

export const stopReasonSchema = z.enum([
  'end_turn',
  'cancelled',
  'max_tokens',
  'max_turn_requests',
  'refusal',
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

const rpcId = z.union([z.number(), z.string()]);

/**
 * Uma frame JSON-RPC 2.0 vinda do agente: pedido, notificacao ou resposta.
 *
 * A ordem importa e a resposta vem por ultimo de proposito: ela e a unica sem
 * `method`, entao so chega ate ela o que as outras duas ja recusaram. Descrever
 * a resposta como "`method` ausente" nao funciona -- no Zod uma chave declarada
 * como `undefined` continua sendo obrigatoria, e toda resposta seria jogada
 * fora em silencio.
 */
export const rpcFrameSchema = z.union([
  z.object({ id: rpcId, method: z.string().min(1), params: z.unknown().optional() }),
  z.object({ method: z.string().min(1), params: z.unknown().optional() }),
  z.object({
    id: rpcId,
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  }),
]);
export type RpcFrame = z.infer<typeof rpcFrameSchema>;

/** Devolve `null` em vez de lancar: linha malformada nao derruba a execucao. */
export function parseFrame(value: unknown): RpcFrame | null {
  const parsed = rpcFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
