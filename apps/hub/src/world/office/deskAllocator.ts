import { hashString } from './palette';
import { DESKS } from './layout';

/** Marcador de quem nao coube em mesa nenhuma e vai para a fileira de espera. */
export const OVERFLOW_DESK = -1;

/**
 * Atribuicao deterministica de mesa por agentId: o hash aponta a mesa inicial
 * e uma sondagem linear em ordem fixa resolve colisoes. Mesma lista de ids, na
 * mesma ordem, produz sempre a mesma atribuicao -- e truncar o fim da lista
 * nao muda a mesa de ninguem, entao um despawn nunca embaralha quem ficou.
 */
export function allocateDesks(agentIds: readonly string[]): Readonly<Record<string, number>> {
  const taken = new Set<number>();
  const assigned: Record<string, number> = {};

  for (const agentId of agentIds) {
    if (taken.size >= DESKS.length) {
      assigned[agentId] = OVERFLOW_DESK;
      continue;
    }
    let desk = hashString(agentId) % DESKS.length;
    while (taken.has(desk)) desk = (desk + 1) % DESKS.length;
    taken.add(desk);
    assigned[agentId] = desk;
  }

  return assigned;
}
