/**
 * Planta baixa do escritorio: grade de tiles, porta, mesas, plantas e os
 * caminhos entre eles. Tudo aqui e dado puro ou funcao pura -- e o que
 * permite provar em teste que toda mesa e alcancavel a partir da porta.
 *
 * A grade tem GRID_SIZE x GRID_SIZE tiles de 1 unidade. O tile (col, row) tem
 * centro no mundo em (col - GRID_SIZE/2 + 0.5, row - GRID_SIZE/2 + 0.5).
 * +x aponta para leste, +z para sul; a camera olha do sudeste.
 */
export const GRID_SIZE = 16;

export interface Tile {
  readonly col: number;
  readonly row: number;
}

export interface WorldPoint {
  readonly x: number;
  readonly z: number;
}

/** Tile da porta, na borda sul: o ponto de spawn de todo mundo. */
export const DOOR: Tile = { col: 8, row: GRID_SIZE - 1 };

export interface DeskSpot {
  /** Tile da mesa em si. */
  readonly tile: Tile;
  /** Tile da cadeira, onde o personagem senta para trabalhar. */
  readonly chair: Tile;
  /** Tile onde o personagem fica em pe (idle, pensando, bloqueado). */
  readonly stand: Tile;
  /** Rotacao Y de quem esta sentado na cadeira, olhando para a mesa. */
  readonly rotationY: number;
}

// Mesas encostadas nas paredes norte, oeste e leste, viradas para dentro.
// O corredor central (col 8) e as fileiras de cada mesa ficam livres, entao
// o caminho da porta ate qualquer mesa e sempre reto ou em L.
const northDesks: DeskSpot[] = [3, 5, 7, 9, 11, 13].map((col) => ({
  tile: { col, row: 1 },
  chair: { col, row: 2 },
  stand: { col, row: 3 },
  rotationY: Math.PI,
}));

const westDesks: DeskSpot[] = [5, 8, 11].map((row) => ({
  tile: { col: 1, row },
  chair: { col: 2, row },
  stand: { col: 3, row },
  rotationY: -Math.PI / 2,
}));

const eastDesks: DeskSpot[] = [5, 8, 11].map((row) => ({
  tile: { col: 14, row },
  chair: { col: 13, row },
  stand: { col: 12, row },
  rotationY: Math.PI / 2,
}));

export const DESKS: readonly DeskSpot[] = [...northDesks, ...westDesks, ...eastDesks];

export const PLANT_SPOTS: readonly Tile[] = [
  { col: 1, row: 1 },
  { col: 14, row: 1 },
  { col: 1, row: 13 },
  { col: 14, row: 13 },
];

/**
 * Fileira de espera para quando ha mais agentes vivos do que mesas: encostados
 * na parede sul, deixando a coluna da porta livre.
 */
export const OVERFLOW_SPOTS: readonly { readonly tile: Tile; readonly rotationY: number }[] = [
  2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13,
].map((col) => ({ tile: { col, row: 14 }, rotationY: Math.PI }));

const tileKey = (tile: Tile): string => `${tile.col},${tile.row}`;

/** Tiles que bloqueiam caminhada: mesas, cadeiras e plantas. */
export const OCCUPIED_TILES: ReadonlySet<string> = new Set([
  ...DESKS.flatMap((desk) => [tileKey(desk.tile), tileKey(desk.chair)]),
  ...PLANT_SPOTS.map(tileKey),
]);

export function tileToWorld(tile: Tile): WorldPoint {
  return { x: tile.col - GRID_SIZE / 2 + 0.5, z: tile.row - GRID_SIZE / 2 + 0.5 };
}

export const DOOR_WORLD: WorldPoint = tileToWorld(DOOR);

/**
 * Caminho em L: primeiro anda em z (o corredor central leva da porta para
 * dentro), depois em x. O layout foi desenhado para essa ordem nunca cruzar
 * um tile ocupado -- o teste de layout prova isso para cada mesa.
 */
export function buildPath(from: WorldPoint, to: WorldPoint): readonly WorldPoint[] {
  const corner: WorldPoint = { x: from.x, z: to.z };
  // Cotovelo so existe quando o caminho dobra de verdade: se x ou z ja
  // coincidem, o trecho e reto e o canto seria um ponto parado no caminho.
  const bends = Math.abs(to.z - from.z) > 1e-6 && Math.abs(to.x - from.x) > 1e-6;
  return bends ? [corner, to] : [to];
}

/**
 * Amostra o caminho tile a tile e confere se nao pisa em tile ocupado. O tile
 * de destino nao conta: sentar na cadeira e exatamente pisar nela.
 */
export function pathIsClear(
  from: WorldPoint,
  to: WorldPoint,
  occupied: ReadonlySet<string> = OCCUPIED_TILES,
): boolean {
  const points: WorldPoint[] = [from, ...buildPath(from, to)];
  const destinationKey = `${Math.floor(to.x + GRID_SIZE / 2)},${Math.floor(to.z + GRID_SIZE / 2)}`;

  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const a = points[segment];
    const b = points[segment + 1];
    if (a === undefined || b === undefined) return false;

    const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z)) * 2);
    for (let step = 1; step <= steps; step += 1) {
      const x = a.x + ((b.x - a.x) * step) / steps;
      const z = a.z + ((b.z - a.z) * step) / steps;
      const key = `${Math.floor(x + GRID_SIZE / 2)},${Math.floor(z + GRID_SIZE / 2)}`;
      if (key === destinationKey) continue;
      if (occupied.has(key)) return false;
    }
  }
  return true;
}
