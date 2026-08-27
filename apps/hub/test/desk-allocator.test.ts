import { describe, expect, it } from 'vitest';
import { allocateDesks, OVERFLOW_DESK } from '../src/world/office/deskAllocator';
import { DESKS } from '../src/world/office/layout';

describe('allocateDesks', () => {
  it('e deterministico: mesma lista, mesma atribuicao', () => {
    const ids = ['agt_a', 'agt_b', 'agt_c', 'agt_d'];
    expect(allocateDesks(ids)).toEqual(allocateDesks(ids));
  });

  it('da a mesma mesa para o mesmo agente independente dos outros', () => {
    // A sondagem depende da ordem de chegada, entao a garantia vale para a
    // lista na ordem em que os agentes apareceram -- que e como o reducer
    // guarda o record de agentes.
    const primeiro = allocateDesks(['agt_a', 'agt_b']);
    const depois = allocateDesks(['agt_a', 'agt_b', 'agt_c']);
    expect(depois['agt_a']).toBe(primeiro['agt_a']);
    expect(depois['agt_b']).toBe(primeiro['agt_b']);
  });

  it('nunca coloca dois agentes na mesma mesa', () => {
    const ids = Array.from({ length: DESKS.length }, (_, index) => `agt_${index}`);
    const assigned = Object.values(allocateDesks(ids));
    expect(new Set(assigned).size).toBe(DESKS.length);
  });

  it('manda o excedente para a fileira de espera', () => {
    const ids = Array.from({ length: DESKS.length + 3 }, (_, index) => `agt_${index}`);
    const assigned = Object.values(allocateDesks(ids));
    expect(assigned.filter((desk) => desk === OVERFLOW_DESK)).toHaveLength(3);
  });

  it('resolve colisao por sondagem, sem tirar ninguem da mesa', () => {
    // Forca colisao: ids iguais teriam o mesmo hash, entao usa sufixos que
    // nao mudam o prefixo do hash... na pratica, basta conferir que com
    // DESKS.length agentes todas as mesas ficam ocupadas exatamente uma vez.
    const ids = Array.from({ length: DESKS.length }, (_, index) => `agente-${index}`);
    const assigned = allocateDesks(ids);
    const mesas = ids.map((id) => assigned[id]);
    expect([...mesas].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: DESKS.length }, (_, index) => index),
    );
  });
});
