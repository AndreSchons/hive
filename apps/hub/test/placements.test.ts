import { describe, expect, it } from 'vitest';
import type { AgentState } from '@office/protocol';
import type { AgentView } from '../src/state/event-reducer';
import { derivePlacements } from '../src/world/office/placements';
import { AGENT_COLORS, agentColor, HAIR_TONES, PANTS_TONES, SKIN_TONES } from '../src/world/office/palette';
import { DESKS, tileToWorld } from '../src/world/office/layout';

function agent(agentId: string, state: AgentState, present = true): AgentView {
  return {
    agentId,
    role: 'papel',
    displayName: `Agente ${agentId}`,
    adapter: 'kimi',
    state,
    worktreePath: '/copias/x',
    branch: 'office/x',
    currentTaskId: null,
    lastSaid: null,
    present,
  };
}

function single(state: AgentState, present = true) {
  const placements = derivePlacements({ agt_a: agent('agt_a', state, present) });
  const placement = placements[0];
  if (placement === undefined) throw new Error('esperava um placement');
  return placement;
}

describe('agentColor', () => {
  it('e deterministico e sai da paleta', () => {
    for (const id of ['agt_a', 'agt_b', 'agt_c', 'agt_gerente']) {
      expect(agentColor(id)).toBe(agentColor(id));
      expect(AGENT_COLORS).toContain(agentColor(id));
    }
  });
});

describe('aparencia do personagem', () => {
  it('e deterministica por agentId e sai dos tons da paleta', () => {
    const primeiro = single('idle').appearance;
    const deNovo = single('idle').appearance;

    expect(primeiro).toEqual(deNovo);
    expect(SKIN_TONES).toContain(primeiro.skin);
    expect(HAIR_TONES).toContain(primeiro.hair);
    expect(PANTS_TONES).toContain(primeiro.pants);
    expect(primeiro.hairStyle).toBeGreaterThanOrEqual(0);
    expect(primeiro.hairStyle).toBeLessThan(4);
  });

  it('varia entre pessoas diferentes', () => {
    const placements = derivePlacements({
      agt_a: agent('agt_a', 'idle'),
      agt_b: agent('agt_b', 'idle'),
      agt_c: agent('agt_c', 'idle'),
      agt_d: agent('agt_d', 'idle'),
    });
    const assinaturas = new Set(placements.map((p) => JSON.stringify(p.appearance)));
    // Quatro pessoas com a mesma aparencia seria suspeito de hash quebrado.
    expect(assinaturas.size).toBeGreaterThan(1);
  });
});

describe('derivePlacements', () => {
  it('working senta na cadeira digitando', () => {
    const placement = single('working');
    expect(placement.anim).toBe('type');
    expect(placement.seated).toBe(true);

    const desk = DESKS.find(
      (candidate) => tileToWorld(candidate.chair).x === placement.target.x
        && tileToWorld(candidate.chair).z === placement.target.z,
    );
    expect(desk).toBeDefined();
    expect(placement.rotationY).toBe(desk?.rotationY);
  });

  it('idle fica em pe no pe da mesa, de costas para ela e com o rosto para a sala', () => {
    const placement = single('idle');
    expect(placement.anim).toBe('idle');
    expect(placement.seated).toBe(false);

    const desk = DESKS.find(
      (candidate) => tileToWorld(candidate.stand).x === placement.target.x
        && tileToWorld(candidate.stand).z === placement.target.z,
    );
    expect(desk).toBeDefined();
    expect(placement.rotationY).toBeCloseTo((desk?.rotationY ?? 0) + Math.PI, 5);
  });

  it('thinking fica em pe com bob lento', () => {
    const placement = single('thinking');
    expect(placement.anim).toBe('think');
    expect(placement.seated).toBe(false);
  });

  it('talking e blocked ficam mapeados no idle ate a proxima sessao', () => {
    expect(single('talking').anim).toBe('idle');
    expect(single('blocked').anim).toBe('idle');
  });

  it('done volta para o idle em pe', () => {
    const placement = single('done');
    expect(placement.anim).toBe('idle');
    expect(placement.seated).toBe(false);
  });

  it('mantem o placement de quem ja saiu, marcado como ausente', () => {
    const placement = single('done', false);
    expect(placement.present).toBe(false);
    expect(placement.anim).toBe('idle');
  });

  it('a mesa de um agente nao muda quando outro sai de cena', () => {
    const antes = derivePlacements({
      agt_a: agent('agt_a', 'working'),
      agt_b: agent('agt_b', 'working'),
      agt_c: agent('agt_c', 'idle'),
    });
    const depois = derivePlacements({
      agt_a: agent('agt_a', 'working'),
      agt_b: agent('agt_b', 'done', false),
      agt_c: agent('agt_c', 'idle'),
    });

    expect(depois.find((p) => p.agentId === 'agt_a')?.target)
      .toEqual(antes.find((p) => p.agentId === 'agt_a')?.target);
    expect(depois.find((p) => p.agentId === 'agt_c')?.target)
      .toEqual(antes.find((p) => p.agentId === 'agt_c')?.target);
  });

  it('e puro: mesma entrada, mesma saida', () => {
    const agents = {
      agt_a: agent('agt_a', 'working'),
      agt_b: agent('agt_b', 'thinking'),
    };
    expect(derivePlacements(agents)).toEqual(derivePlacements(agents));
  });
});
