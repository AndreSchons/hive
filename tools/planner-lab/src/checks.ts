import type { Plan, Roster, Subtask } from '@office/protocol';
import type { AvailableGate } from '@office/coordination';

/**
 * O que da para medir sem opiniao.
 *
 * Nada aqui julga se o plano e bom -- isso e leitura sua. O que estas checagens
 * fazem e tirar da sua frente o que e objetivo, para voce gastar atencao no que
 * nao e. Depois de oito planos seguidos, e a diferenca entre revisar e chutar.
 */
export interface Finding {
  readonly level: 'erro' | 'aviso';
  readonly message: string;
}

export interface PlanReport {
  readonly subtasks: number;
  readonly contracts: number;
  /** Maior corrente de dependencias. 1 = tudo solto, N = tudo em fila. */
  readonly depth: number;
  /** Quantas poderiam rodar juntas na primeira leva. */
  readonly firstWave: number;
  readonly findings: readonly Finding[];
}

export interface CheckInput {
  readonly plan: Plan;
  readonly roster: Roster;
  readonly gates: readonly AvailableGate[];
}

export function checkPlan({ plan, roster, gates }: CheckInput): PlanReport {
  const findings: Finding[] = [
    ...unknownRoles(plan, roster),
    ...inventedGates(plan, gates),
    ...pathCollisions(plan),
    ...danglingContracts(plan),
  ];

  return {
    subtasks: plan.subtasks.length,
    contracts: plan.contracts.length,
    depth: depthOf(plan),
    firstWave: plan.subtasks.filter((subtask) => subtask.dependsOn.length === 0).length,
    findings,
  };
}

/** Papel que nao esta no roster: a subtask nao teria quem a executasse. */
function unknownRoles(plan: Plan, roster: Roster): Finding[] {
  const known = new Set(roster.map((role) => String(role.id)));
  return plan.subtasks
    .filter((subtask) => !known.has(String(subtask.role)))
    .map((subtask) => ({
      level: 'erro' as const,
      message: `"${subtask.id}" usa o papel "${subtask.role}", que nao existe no roster`,
    }));
}

/**
 * Portao que o projeto nao tem. Passa no schema, parece plano valido, e so
 * quebra na hora de verificar -- que e tarde demais para descobrir.
 */
function inventedGates(plan: Plan, gates: readonly AvailableGate[]): Finding[] {
  if (gates.length === 0) return [];
  const known = new Set(gates.map((gate) => gate.command.trim()));
  return plan.subtasks
    .filter((subtask) => !known.has(subtask.gate.command.trim()))
    .map((subtask) => ({
      level: 'aviso' as const,
      message: `"${subtask.id}" verifica com \`${subtask.gate.command}\`, que nao esta nos scripts do projeto`,
    }));
}

/**
 * A checagem que mais importa: subtasks sem dependencia entre si que declaram o
 * mesmo caminho. Elas podem rodar juntas, e vao colidir no merge. E o preditor
 * direto do conflito que o resto do sistema existe para detectar e parar.
 */
function pathCollisions(plan: Plan): Finding[] {
  const findings: Finding[] = [];

  for (const [index, one] of plan.subtasks.entries()) {
    for (const other of plan.subtasks.slice(index + 1)) {
      if (related(plan, one, other)) continue;
      const shared = one.allowedPaths.filter((path) =>
        other.allowedPaths.some((candidate) => overlaps(path, candidate)),
      );
      if (shared.length > 0) {
        findings.push({
          level: 'aviso',
          message: `"${one.id}" e "${other.id}" nao dependem uma da outra mas dividem ${shared.join(', ')}`,
        });
      }
    }
  }

  const semCaminho = plan.subtasks.filter((subtask) => subtask.allowedPaths.length === 0);
  if (semCaminho.length > 1) {
    findings.push({
      level: 'aviso',
      message: `${semCaminho.length} subtasks sem allowedPaths: nao da para saber se vao colidir`,
    });
  }
  return findings;
}

/** Um caminho contem o outro, ou sao o mesmo. */
function overlaps(one: string, other: string): boolean {
  const a = one.replace(/\/+$/, '');
  const b = other.replace(/\/+$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Uma alcanca a outra pelo grafo? Entao nunca rodam ao mesmo tempo. */
function related(plan: Plan, one: Subtask, other: Subtask): boolean {
  return reaches(plan, one.id, other.id) || reaches(plan, other.id, one.id);
}

function reaches(plan: Plan, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current === to) return true;
    const node = plan.subtasks.find((subtask) => subtask.id === current);
    for (const next of node?.dependsOn ?? []) stack.push(next);
  }
  return false;
}

/** Contrato publicado que ninguem consome: trabalho a toa, nao erro. */
function danglingContracts(plan: Plan): Finding[] {
  const used = new Set(plan.subtasks.flatMap((subtask) => subtask.inputContracts.map(String)));
  return plan.contracts
    .filter((contract) => !used.has(String(contract.id)))
    .map((contract) => ({
      level: 'aviso' as const,
      message: `o contrato "${contract.id}" foi publicado mas nenhuma subtask o usa`,
    }));
}

/** Maior corrente de dependencias do grafo. */
function depthOf(plan: Plan): number {
  const cache = new Map<string, number>();

  const walk = (id: string): number => {
    const known = cache.get(id);
    if (known !== undefined) return known;
    const node = plan.subtasks.find((subtask) => subtask.id === id);
    // Marca antes de descer: o grafo ja foi validado sem ciclo, mas o harness
    // tambem le plano vindo de arquivo, e travar aqui seria pior que responder.
    cache.set(id, 1);
    const depth = 1 + Math.max(0, ...(node?.dependsOn ?? []).map(walk));
    cache.set(id, depth);
    return depth;
  };

  return Math.max(0, ...plan.subtasks.map((subtask) => walk(subtask.id)));
}
