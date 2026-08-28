import { describe, expect, it } from 'vitest';
import type { AgentState } from '@office/protocol';
import type { AgentView } from '../src/state/event-reducer';
import { derivePlacements } from '../src/world/office/placements';
import { AGENT_COLORS, agentColor, HAIR_TONES, PANTS_TONES, SKIN_TONES } from '../src/world/office/palette';
import {
  buildRoute,
  CORRIDOR_X,
  DESKS,
  DOOR_WORLD,
  LOUNGE_SEATS,
  pathIsClear,
  tileToWorld,
} from '../src/world/office/layout';

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
    doneSeq: present ? null : 1,
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

  it('quem terminou nao sai de cena: vai descansar no lounge', () => {
    const placement = single('done', false);
    expect(placement.present).toBe(false);
    expect(placement.anim).toBe('armchair');
    expect(placement.seated).toBe(true);
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

/**
 * Quem entrega larga a mesa e atravessa a sala. O que este bloco cobra e a
 * regra que segura tudo: a fila do lounge **so cresce pelo fim**. Quem ja
 * sentou nunca muda de lugar quando o proximo termina -- senao o escritorio
 * embaralharia sozinho a cada entrega, e ninguem entenderia o que aconteceu.
 */
describe('quem terminou vai para o lounge', () => {
  const feito = (agentId: string, doneSeq: number): AgentView => ({
    ...agent(agentId, 'done', false),
    doneSeq,
  });

  const lugares = (agents: Record<string, AgentView>): Record<string, string> =>
    Object.fromEntries(
      derivePlacements(agents).map((p) => [p.agentId, `${p.target.x},${p.target.z}`]),
    );

  it('o primeiro a terminar pega a poltrona, o segundo pega a outra', () => {
    const placements = derivePlacements({
      agt_a: feito('agt_a', 10),
      agt_b: feito('agt_b', 20),
    });

    expect(placements.map((p) => p.anim)).toEqual(['armchair', 'armchair']);
    expect(placements[0]?.target).not.toEqual(placements[1]?.target);
  });

  it('acabadas as poltronas, os seguintes sentam no tapete', () => {
    const agents = Object.fromEntries(
      [10, 20, 30, 40].map((seq, i) => [`agt_${i}`, feito(`agt_${i}`, seq)]),
    );

    expect(derivePlacements(agents).map((p) => p.anim)).toEqual([
      'armchair', 'armchair', 'floor', 'floor',
    ]);
  });

  /** A regra que sustenta o resto: sentou, ficou. */
  it('quem ja sentou nao muda de lugar quando outro termina', () => {
    const antes = lugares({ agt_a: feito('agt_a', 10), agt_b: feito('agt_b', 20) });
    const depois = lugares({
      agt_a: feito('agt_a', 10),
      agt_b: feito('agt_b', 20),
      agt_c: feito('agt_c', 30),
    });

    expect(depois['agt_a']).toBe(antes['agt_a']);
    expect(depois['agt_b']).toBe(antes['agt_b']);
  });

  /**
   * Quem comeca antes nao termina antes. Ordenar pela ordem em que os agentes
   * aparecem no mundo -- e nao por `doneSeq` -- empurraria de lugar quem ja
   * estava sentado assim que um agente mais antigo terminasse.
   */
  it('o lugar segue a ordem de terminar, nao a de aparecer', () => {
    // `agt_a` aparece primeiro no record, mas termina depois de `agt_b`.
    const lugar = lugares({ agt_a: feito('agt_a', 90), agt_b: feito('agt_b', 10) });
    const sozinho = lugares({ agt_b: feito('agt_b', 10) });

    expect(lugar['agt_b']).toBe(sozinho['agt_b']);
    expect(lugar['agt_a']).not.toBe(lugar['agt_b']);
  });

  it('nao rouba lugar de quem ainda esta trabalhando', () => {
    const placements = derivePlacements({
      agt_a: feito('agt_a', 10),
      agt_b: agent('agt_b', 'working'),
    });
    const trabalhando = placements.find((p) => p.agentId === 'agt_b');

    expect(trabalhando?.anim).toBe('type');
    expect(trabalhando?.seated).toBe(true);
    // A mesa continua sendo mesa: quem trabalha nao vai parar no tapete.
    expect(DESKS.some((desk) => {
      const chair = tileToWorld(desk.chair);
      return chair.x === trabalhando?.target.x && chair.z === trabalhando.target.z;
    })).toBe(true);
  });

  /** Lounge cheio nao empilha boneco: encosta na fileira de espera. */
  it('passando dos lugares do lounge, o resto fica em pe sem se sobrepor', () => {
    const agents = Object.fromEntries(
      Array.from({ length: LOUNGE_SEATS.length + 3 }, (_, i) => [
        `agt_${i}`,
        feito(`agt_${i}`, (i + 1) * 10),
      ]),
    );
    const placements = derivePlacements(agents);
    const pontos = new Set(placements.map((p) => `${p.target.x},${p.target.z}`));

    expect(pontos.size).toBe(placements.length);
    expect(placements.slice(LOUNGE_SEATS.length).every((p) => p.anim === 'idle')).toBe(true);
  });
});

/**
 * A travessia ate o lounge. Ela existe porque o caminho em L direto sai de
 * dentro da fileira de cadeiras e atropela quem esta trabalhando ao lado.
 */
describe('a rota de quem vai descansar', () => {
  const feito = (agentId: string, doneSeq: number): AgentView => ({
    ...agent(agentId, 'done', false),
    doneSeq,
  });

  it('quem estava numa mesa sai pelo vao dela e pega o corredor', () => {
    const placement = derivePlacements({ agt_a: feito('agt_a', 10) })[0];
    if (placement === undefined) throw new Error('esperava um placement');

    expect(placement.via.length).toBeGreaterThan(0);
    // Depois da primeira parada -- o vao em frente a mesa -- tudo e corredor.
    expect(placement.via.slice(1).every((point) => point.x === CORRIDOR_X)).toBe(true);
  });

  it('cada trecho da rota, do inicio ao assento, passa longe de movel', () => {
    const agents = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`agt_${i}`, feito(`agt_${i}`, (i + 1) * 10)]),
    );

    for (const placement of derivePlacements(agents)) {
      const desk = DESKS.find((d) => {
        const stand = tileToWorld(d.stand);
        return placement.via[0]?.x === stand.x && placement.via[0]?.z === stand.z;
      });
      const inicio = desk === undefined ? DOOR_WORLD : tileToWorld(desk.chair);
      const paradas = [inicio, ...buildRoute(inicio, placement.via, placement.target)];

      for (let i = 0; i < paradas.length - 1; i += 1) {
        const [a, b] = [paradas[i], paradas[i + 1]];
        if (a === undefined || b === undefined) throw new Error('rota quebrada');
        expect(pathIsClear(a, b)).toBe(true);
      }
    }
  });

  /** Quem esta trabalhando nao ganha desvio: o L direto foi desenhado para isso. */
  it('ir para a propria mesa continua sendo o L direto', () => {
    const placements = derivePlacements({
      agt_a: agent('agt_a', 'working'),
      agt_b: agent('agt_b', 'idle'),
    });

    expect(placements.every((placement) => placement.via.length === 0)).toBe(true);
  });
});
