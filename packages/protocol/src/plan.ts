import { z } from 'zod';
import { contractId, gateId, planId, runId, taskId, agentId } from './ids';
import { modelTierSchema, roleId } from './roles';

/**
 * Portao de verificacao: um comando com resultado objetivo. "Terminei" sem
 * portao verde nao e entrega aceita, entao o portao nunca e opcional.
 */
export const gateKindSchema = z.enum(['typecheck', 'build', 'test', 'lint', 'custom']);
export type GateKind = z.infer<typeof gateKindSchema>;

export const gateSchema = z.object({
  id: gateId,
  kind: gateKindSchema,
  /** Comando executado na worktree do agente. Codigo de saida 0 = passou. */
  command: z.string().min(1),
  /** Relativo a raiz da worktree. */
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().positive().default(300_000),
});
export type Gate = z.infer<typeof gateSchema>;

/**
 * Artefato de contrato: o que liga o trabalho de dois especialistas que vao
 * correr em paralelo. Publicado pelo gerente antes da paralelizacao.
 */
export const contractKindSchema = z.enum(['types', 'signatures', 'routes', 'schema', 'other']);

export const contractSchema = z.object({
  id: contractId,
  kind: contractKindSchema,
  title: z.string().min(1),
  /** Conteudo textual do contrato (assinaturas, tipos, rotas). */
  body: z.string().min(1),
  /** Caminho onde o contrato foi materializado no repositorio, se houver. */
  path: z.string().min(1).optional(),
});
export type Contract = z.infer<typeof contractSchema>;

export const budgetSchema = z.object({
  /** Turnos do agente antes de parar e perguntar. */
  maxTurns: z.number().int().positive().default(30),
  maxDurationMs: z.number().int().positive().default(900_000),
  /** Repeticoes identicas toleradas antes de declarar loop. */
  maxRepeats: z.number().int().positive().default(2),
});
export type Budget = z.infer<typeof budgetSchema>;

export const subtaskSchema = z.object({
  id: taskId,
  title: z.string().min(1),
  /** Descricao em linguagem natural, o prompt que vai para o especialista. */
  description: z.string().min(1),
  role: roleId,
  dependsOn: z.array(taskId).default([]),
  /** Areas do repositorio que esta subtask pode tocar. Vazio = sem restricao. */
  allowedPaths: z.array(z.string().min(1)).default([]),
  /** Contratos que entram como input obrigatorio desta subtask. */
  inputContracts: z.array(contractId).default([]),
  /** Criterio de pronto, em linguagem que o usuario entende. */
  doneWhen: z.string().min(1),
  gate: gateSchema,
  budget: budgetSchema,
  /**
   * Que degrau de modelo este passo pede, e por que -- em linguagem de gente,
   * porque isso aparece na tela para a pessoa aprovar.
   *
   * Preenchido pelo **sistema**, a partir do que o plano ja declara (quantas
   * areas toca, se tem contrato, quantos passos dependem dele). O modelo nao
   * escolhe o proprio modelo pela mesma razao que nao define o proprio teto de
   * turnos: quem paga a conta e quem decide.
   */
  modelTier: modelTierSchema.default('padrao'),
  modelReason: z.string().min(1).default('tamanho comum'),
});
export type Subtask = z.infer<typeof subtaskSchema>;

const planShape = z.object({
  id: planId,
  runId,
  /** Incrementa a cada `plan.revised`. */
  revision: z.number().int().nonnegative().default(0),
  createdBy: agentId,
  goal: z.string().min(1),
  subtasks: z.array(subtaskSchema).min(1),
  contracts: z.array(contractSchema).default([]),
});

/**
 * Um plano so e valido se o grafo de dependencias fechar: ids unicos,
 * dependencias existentes, contratos declarados e nenhum ciclo.
 */
/**
 * A validacao de grafo, uma vez so. Vale tanto para o plano completo quanto
 * para o rascunho que o modelo devolve -- duas versoes divergindo deixariam
 * passar no rascunho o que o plano recusa, e o erro apareceria tarde demais.
 */
export function refinePlanGraph(
  plan: { readonly subtasks: readonly MinimalSubtask[]; readonly contracts: readonly { readonly id: string }[] },
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, subtask] of plan.subtasks.entries()) {
    if (ids.has(subtask.id)) {
      ctx.addIssue({ code: 'custom', path: ['subtasks', index, 'id'], message: `subtask duplicada: ${subtask.id}` });
    }
    ids.add(subtask.id);
  }

  const contractIds = new Set(plan.contracts.map((contract) => contract.id));

  for (const [index, subtask] of plan.subtasks.entries()) {
    for (const dependency of subtask.dependsOn) {
      if (!ids.has(dependency)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subtasks', index, 'dependsOn'],
          message: `dependencia inexistente: ${dependency}`,
        });
      }
      if (dependency === subtask.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['subtasks', index, 'dependsOn'],
          message: `subtask depende de si mesma: ${subtask.id}`,
        });
      }
    }
    for (const contract of subtask.inputContracts) {
      if (!contractIds.has(contract)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subtasks', index, 'inputContracts'],
          message: `contrato nao publicado no plano: ${contract}`,
        });
      }
    }
  }

  const cycle = findCycle(plan.subtasks);
  if (cycle) {
    ctx.addIssue({ code: 'custom', path: ['subtasks'], message: `ciclo de dependencias: ${cycle.join(' -> ')}` });
  }
}

/**
 * Um plano so e valido se o grafo de dependencias fechar: ids unicos,
 * dependencias existentes, contratos declarados e nenhum ciclo.
 */
export const planSchema = planShape.superRefine(refinePlanGraph);
export type Plan = z.infer<typeof planSchema>;

type MinimalNode = { readonly id: string; readonly dependsOn: readonly string[] };
type MinimalSubtask = MinimalNode & { readonly inputContracts: readonly string[] };

/** Busca em profundidade com pilha explicita. Devolve o ciclo ou null. */
export function findCycle(nodes: readonly MinimalNode[]): string[] | null {
  const edges = new Map<string, readonly string[]>(nodes.map((node) => [node.id, node.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const trail: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') return [...trail.slice(trail.indexOf(id)), id];

    state.set(id, 'visiting');
    trail.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found) return found;
    }
    trail.pop();
    state.set(id, 'done');
    return null;
  };

  for (const node of nodes) {
    const found = visit(node.id);
    if (found) return found;
  }
  return null;
}

/**
 * Subtasks liberadas para execucao: dependencias todas concluidas.
 * Ordem topologica e problema de quem agenda, nao do schema.
 */
export function readySubtasks(plan: Plan, completed: ReadonlySet<string>): Subtask[] {
  return plan.subtasks.filter(
    (subtask) =>
      !completed.has(subtask.id) && subtask.dependsOn.every((dependency) => completed.has(dependency)),
  );
}

/**
 * O rascunho que o modelo devolve.
 *
 * A divisao e deliberada: o modelo **nao** inventa `planId`, `runId`,
 * `revision`, `createdBy` nem id de portao -- isso e do sistema. Mas ele
 * **precisa** inventar id de subtask e de contrato, porque e com eles que liga
 * `dependsOn` e `inputContracts`. Como o id e string livre, um slug legivel
 * ("schema-do-login") passa -- e num plano lido por gente vale muito mais que
 * `tsk_a1b2c3d4`.
 */
export const gateDraftSchema = gateSchema.omit({ id: true });
export type GateDraft = z.infer<typeof gateDraftSchema>;

export const contractDraftSchema = contractSchema;
export type ContractDraft = z.infer<typeof contractDraftSchema>;

/**
 * Sem `budget` nem degrau de modelo: os dois sao decisao de quem paga a conta,
 * nao de quem gasta. Um gerente que define o proprio teto de turnos nao tem
 * teto nenhum, e um que escolhe o proprio modelo tambem nao.
 */
export const subtaskDraftSchema = subtaskSchema
  .omit({ budget: true, modelTier: true, modelReason: true })
  .extend({ gate: gateDraftSchema });
export type SubtaskDraft = z.infer<typeof subtaskDraftSchema>;

export const planDraftSchema = z
  .object({
    subtasks: z.array(subtaskDraftSchema).min(1).max(12),
    contracts: z.array(contractDraftSchema).default([]),
  })
  .superRefine(refinePlanGraph);
export type PlanDraft = z.infer<typeof planDraftSchema>;

/**
 * O contrato que vai dentro do prompt do gerente, **derivado do mesmo Zod**.
 * Escrever o JSON Schema a mao criaria duas fontes de verdade que divergem em
 * silencio: o modelo obedeceria uma e o parse cobraria a outra.
 */
export const planJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(planDraftSchema, { io: 'input' }) as Record<string, unknown>;

/**
 * Parse que explica em vez de lancar.
 *
 * Mora aqui, junto do schema, porque quem valida e quem sabe dizer o que
 * faltou -- e porque assim ninguem mais precisa conhecer o formato de erro do
 * Zod so para conferir um plano.
 */
export type PlanParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

export function parsePlanDraft(raw: unknown): PlanParse<PlanDraft> {
  const parsed = planDraftSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, problem: z.prettifyError(parsed.error) };
}

export function parsePlan(raw: unknown): PlanParse<Plan> {
  const parsed = planSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, problem: z.prettifyError(parsed.error) };
}
