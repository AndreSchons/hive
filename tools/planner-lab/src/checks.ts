import type { Plan, Roster, Subtask } from '@hive/protocol';
import { chooseCoRunnable, pathsOverlap, type AvailableGate } from '@hive/coordination';

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
  /** Quantas o executor larga juntas na primeira leva -- a conta dele, nao uma estimativa. */
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
    firstWave: firstWaveOf(plan),
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
 * Quantas subtasks partem juntas de verdade.
 *
 * Contar as sem dependencia superestimava: o grafo libera, mas quem decide e o
 * executor, e ele segura quem mexe na area de quem ja esta rodando. Chamar a
 * funcao dele e o que faz este numero prever a execucao em vez de descrever o
 * grafo.
 */
function firstWaveOf(plan: Plan): number {
  const soltas = plan.subtasks.filter((subtask) => subtask.dependsOn.length === 0);
  // Sem teto: aqui a pergunta e quantas o plano **permite**, nao quantas cabem
  // nos lugares que o app abriu -- esse limite muda e o plano nao.
  return chooseCoRunnable(soltas, [], soltas.length).start.length;
}

/**
 * A checagem que mais importa: subtasks sem dependencia entre si que declaram o
 * mesmo caminho.
 *
 * Elas poderiam rodar juntas e nao vao: o executor poe na fila quem se encosta,
 * justamente para nao adiantar o conflito de merge. Entao isto nao aponta um
 * bug -- aponta paralelismo que o plano deixou na mesa, e e o sinal de que
 * faltou contrato ou faltou separar melhor as areas.
 */
function pathCollisions(plan: Plan): Finding[] {
  const findings: Finding[] = [];

  for (const [index, one] of plan.subtasks.entries()) {
    for (const other of plan.subtasks.slice(index + 1)) {
      if (related(plan, one, other)) continue;
      const shared = one.allowedPaths.filter((path) =>
        other.allowedPaths.some((candidate) => pathsOverlap(path, candidate)),
      );
      if (shared.length > 0) {
        findings.push({
          level: 'aviso',
          message: `"${one.id}" e "${other.id}" nao dependem uma da outra mas dividem ${shared.join(', ')}: vao rodar em fila`,
        });
      }
    }
  }

  const semCaminho = plan.subtasks.filter((subtask) => subtask.allowedPaths.length === 0);
  if (semCaminho.length > 1) {
    findings.push({
      level: 'aviso',
      // Sem area declarada o agente pode mexer em qualquer lugar, e o executor
      // nao aposta: elas nunca correm juntas.
      message: `${semCaminho.length} subtasks sem allowedPaths: nenhuma delas vai rodar em paralelo`,
    });
  }
  return findings;
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
