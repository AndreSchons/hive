import { describe, expect, it } from 'vitest';
import {
  aisleRoute,
  buildPath,
  buildRoute,
  CORRIDOR_X,
  DESKS,
  DOOR,
  DOOR_WORLD,
  GRID_SIZE,
  LOUNGE,
  LOUNGE_SEATS,
  OCCUPIED_TILES,
  pathIsClear,
  tileToWorld,
} from '../src/world/office/layout';

const key = (col: number, row: number) => `${col},${row}`;

describe('layout do escritorio', () => {
  it('tem 6 mesas dentro da grade', () => {
    expect(DESKS).toHaveLength(6);
    for (const desk of DESKS) {
      for (const tile of [desk.tile, desk.chair, desk.stand]) {
        expect(tile.col).toBeGreaterThanOrEqual(0);
        expect(tile.col).toBeLessThan(GRID_SIZE);
        expect(tile.row).toBeGreaterThanOrEqual(0);
        expect(tile.row).toBeLessThan(GRID_SIZE);
      }
    }
  });

  it('nao repete tile entre mesa, cadeira e pe', () => {
    const seen = new Set<string>();
    for (const desk of DESKS) {
      for (const tile of [desk.tile, desk.chair, desk.stand]) {
        const k = key(tile.col, tile.row);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('deixa a porta fora dos tiles ocupados', () => {
    expect(OCCUPIED_TILES.has(key(DOOR.col, DOOR.row))).toBe(false);
  });

  it('alcanca o pe de toda mesa saindo da porta, em linha reta ou em L', () => {
    for (const desk of DESKS) {
      expect(pathIsClear(DOOR_WORLD, tileToWorld(desk.stand))).toBe(true);
    }
  });

  it('alcanca a cadeira a partir do pe da mesa', () => {
    for (const desk of DESKS) {
      expect(pathIsClear(tileToWorld(desk.stand), tileToWorld(desk.chair))).toBe(true);
    }
  });

  it('constroi caminho em L: primeiro em z, depois em x', () => {
    const from = { x: 0.5, z: 7.5 };
    const to = { x: -4.5, z: 0.5 };
    expect(buildPath(from, to)).toEqual([{ x: 0.5, z: 0.5 }, to]);
  });

  it('omite o cotovelo quando o caminho ja e reto', () => {
    const from = { x: 0.5, z: 7.5 };
    const to = { x: 0.5, z: 0.5 };
    expect(buildPath(from, to)).toEqual([to]);
  });

  it('recusa caminho que cruza tile ocupado', () => {
    // Da porta ate a mesa mais proxima da parede norte, em linha reta,
    // atravessa as cadeiras das mesas do norte: tem que acusar bloqueio.
    const northDesk = DESKS[0];
    if (northDesk === undefined) throw new Error('esperava ao menos uma mesa');
    expect(pathIsClear(DOOR_WORLD, tileToWorld(northDesk.tile))).toBe(false);
  });
});

/**
 * Os lugares de descanso. Quem termina atravessa o escritorio inteiro para
 * chegar la, entao valem as mesmas regras das mesas -- e mais uma: eles ficam
 * dentro do tapete, senao o boneco senta no chao de madeira ao lado dele.
 */
describe('lugares do lounge', () => {
  it('alcanca todo lugar de descanso a partir da porta', () => {
    for (const seat of LOUNGE_SEATS) {
      expect(pathIsClear(DOOR_WORLD, seat.point)).toBe(true);
    }
  });

  /**
   * Sair da mesa e ir descansar: a viagem que este recurso inteiro percorre, e
   * a que o L direto **nao** resolve -- por isso ela passa pelo corredor.
   */
  it('atravessa da cadeira de qualquer mesa ate qualquer lugar de descanso', () => {
    for (const desk of DESKS) {
      const chair = tileToWorld(desk.chair);
      for (const seat of LOUNGE_SEATS) {
        const stops = [
          chair,
          ...buildRoute(chair, aisleRoute(tileToWorld(desk.stand), DOOR_WORLD, seat.point), seat.point),
        ];
        for (let i = 0; i < stops.length - 1; i += 1) {
          const [a, b] = [stops[i], stops[i + 1]];
          if (a === undefined || b === undefined) throw new Error('rota quebrada');
          expect(pathIsClear(a, b)).toBe(true);
        }
      }
    }
  });

  /**
   * O que justifica o desvio existir. Se o L direto ja bastasse, a rota pelo
   * corredor seria peso morto -- e este teste avisa no dia em que o layout
   * mudar e ela virar isso.
   */
  it('o L direto da cadeira ate o lounge de fato atropela movel', () => {
    const atropela = DESKS.some((desk) =>
      LOUNGE_SEATS.some((seat) => !pathIsClear(tileToWorld(desk.chair), seat.point)),
    );
    expect(atropela).toBe(true);
  });

  it('a rota pelo corredor passa pela coluna da porta', () => {
    const desk = DESKS[0];
    const seat = LOUNGE_SEATS[0];
    if (desk === undefined || seat === undefined) throw new Error('esperava mesa e assento');

    const via = aisleRoute(tileToWorld(desk.stand), DOOR_WORLD, seat.point);
    expect(via[0]).toEqual(tileToWorld(desk.stand));
    expect(via.slice(1).every((point) => point.x === CORRIDOR_X)).toBe(true);
  });

  it('nao repete parada: ponto igual ao anterior sairia como frame parado', () => {
    const straight = buildRoute({ x: 0.5, z: 7.5 }, [{ x: 0.5, z: 7.5 }], { x: 0.5, z: 0.5 });
    expect(straight).toEqual([{ x: 0.5, z: 0.5 }]);
  });

  it('todo lugar cai dentro do tapete', () => {
    const { center, size } = LOUNGE.rug;
    for (const seat of LOUNGE_SEATS) {
      expect(Math.abs(seat.point.x - center.x)).toBeLessThanOrEqual(size / 2);
      expect(Math.abs(seat.point.z - center.z)).toBeLessThanOrEqual(size / 2);
    }
  });

  /** Um boneco tem ~0,46 de largura: mais perto que isso e um dentro do outro. */
  it('ninguem senta em cima de ninguem, nem da mesinha', () => {
    for (const [index, seat] of LOUNGE_SEATS.entries()) {
      for (const other of LOUNGE_SEATS.slice(index + 1)) {
        expect(Math.hypot(seat.point.x - other.point.x, seat.point.z - other.point.z))
          .toBeGreaterThan(0.6);
      }
      const table = LOUNGE.coffeeTable.center;
      expect(Math.hypot(seat.point.x - table.x, seat.point.z - table.z)).toBeGreaterThan(0.8);
    }
  });

  it('quem senta na poltrona senta onde a poltrona esta', () => {
    const armchairs = LOUNGE_SEATS.filter((seat) => seat.kind === 'armchair');

    expect(armchairs).toHaveLength(LOUNGE.armchairs.length);
    for (const [index, seat] of armchairs.entries()) {
      expect(seat.point).toEqual(LOUNGE.armchairs[index]?.center);
      expect(seat.rotationY).toBe(LOUNGE.armchairs[index]?.rotationY);
    }
  });
});
