import { describe, expect, it } from 'vitest';
import { codePoolFor, CODE_POOL_SIZE } from '../src/world/characters/thoughtCode';

describe('codePoolFor', () => {
  it('e deterministico por agentId', () => {
    expect(codePoolFor('agt_a')).toEqual(codePoolFor('agt_a'));
  });

  it('gira a piscina sem perder nem repetir linha', () => {
    const pool = codePoolFor('agt_b');
    expect(pool).toHaveLength(CODE_POOL_SIZE);
    expect(new Set(pool).size).toBe(CODE_POOL_SIZE);
  });

  it('da pensamentos diferentes para pessoas diferentes (em geral)', () => {
    const a = codePoolFor('agt_a');
    const b = codePoolFor('agt_b');
    const c = codePoolFor('agt_c');
    // Colisao seria possivel por hash, mas tres iguais e sinal de pool quebrado.
    expect(new Set([a[0], b[0], c[0]]).size).toBeGreaterThan(1);
  });
});
