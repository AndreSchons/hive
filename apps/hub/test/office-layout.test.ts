import { describe, expect, it } from 'vitest';
import {
  buildPath,
  DESKS,
  DOOR,
  DOOR_WORLD,
  GRID_SIZE,
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
