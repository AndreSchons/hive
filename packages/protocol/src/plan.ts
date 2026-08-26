import { z } from 'zod';
import { contractId, gateId, planId, runId, taskId, agentId } from './ids';
import { roleId } from './roles';

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
export const planSchema = planShape.superRefine((plan, ctx) => {
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
});
export type Plan = z.infer<typeof planSchema>;

type MinimalNode = { readonly id: string; readonly dependsOn: readonly string[] };

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
