/**
 * Planta baixa do escritorio-diorama: grade de tiles, porta, mesas, lounge e
 * os pontos fixos de mobilia. Tudo aqui e dado puro ou funcao pura -- e o que
 * permite provar em teste que toda mesa e alcancavel a partir da porta.
 *
 * A grade tem GRID_SIZE x GRID_SIZE tiles de 1 unidade. O tile (col, row) tem
 * centro no mundo em (col - GRID_SIZE/2 + 0.5, row - GRID_SIZE/2 + 0.5).
 * +x aponta para leste, +z para sul. A camera olha do sudeste, entao as
 * paredes de fundo (norte e oeste) formam o L do diorama e a frente fica
 * aberta -- nenhum personagem fica atras de parede por construcao.
 */
export const GRID_SIZE = 16;

/** Altura cheia das paredes de fundo. */
export const WALL_HEIGHT = 3;
export const WALL_THICKNESS = 0.35;

export interface Tile {
  readonly col: number;
  readonly row: number;
}

export interface WorldPoint {
  readonly x: number;
  readonly z: number;
}

/** Tile da porta, na borda sul aberta: o ponto de spawn de todo mundo. */
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

// Seis mesas em duas baias encostadas nas paredes de fundo, viradas para elas.
// O corredor central (col 8) e as fileiras de cada mesa ficam livres, entao o
// caminho da porta ate qualquer mesa e sempre reto ou em L.
const northDesks: DeskSpot[] = [5, 8, 11].map((col) => ({
  tile: { col, row: 1 },
  chair: { col, row: 2 },
  stand: { col, row: 3 },
  rotationY: Math.PI,
}));

const westDesks: DeskSpot[] = [8, 10, 12].map((row) => ({
  tile: { col: 1, row },
  chair: { col: 2, row },
  stand: { col: 3, row },
  rotationY: -Math.PI / 2,
}));

export const DESKS: readonly DeskSpot[] = [...northDesks, ...westDesks];

/** Tres plantas de chao, em tamanhos diferentes (grande, media, pequena). */
export const PLANT_SPOTS: readonly { readonly tile: Tile; readonly scale: number }[] = [
  { tile: { col: 14, row: 2 }, scale: 1 },
  { tile: { col: 2, row: 13 }, scale: 0.75 },
  { tile: { col: 14, row: 14 }, scale: 0.5 },
];

/** Estantes altas, uma em cada parede de fundo. */
export const BOOKSHELVES: readonly { readonly center: WorldPoint; readonly rotationY: number }[] = [
  { center: { x: -6, z: -7.1 }, rotationY: 0 },
  { center: { x: -7.1, z: 6.5 }, rotationY: Math.PI / 2 },
];

/** Aparador baixo encostado na parede oeste, com uma planta em cima. */
export const SIDEBOARD = { center: { x: -7.05, z: -2 }, rotationY: Math.PI / 2 } as const;

/** Lounge no canto sudeste: tapete com poltronas e mesinha. */
export const LOUNGE = {
  rug: { center: { x: 4, z: 4 }, size: 4 } as const,
  armchairs: [
    { center: { x: 2.8, z: 2.8 }, rotationY: (3 * Math.PI) / 4 },
    { center: { x: 5.2, z: 5.2 }, rotationY: -Math.PI / 4 },
  ] as const,
  coffeeTable: { center: { x: 4, z: 4 } } as const,
};

/**
 * Onde quem terminou vai descansar.
 *
 * Quem entrega nao some do escritorio: levanta da mesa, atravessa a sala e
 * senta no lounge enquanto os outros seguem trabalhando. E o que faz a tela
 * contar o progresso sozinha -- quanta gente ja acabou se ve de relance, sem
 * ler nada.
 *
 * A ordem importa: quem termina primeiro pega a poltrona, e os seguintes vao
 * para o tapete. Como a fila so cresce pelo fim, ninguem que ja sentou muda de
 * lugar quando o proximo chega.
 *
 * Todo ponto aqui obedece a duas regras que o teste de layout cobra: o caminho
 * em L da porta ate ele nao pisa em movel nenhum, e a distancia para os
 * vizinhos e maior que a largura de um boneco.
 */
export interface LoungeSeat {
  readonly point: WorldPoint;
  /** Rotacao Y de quem esta sentado: todo mundo olhando para a mesinha. */
  readonly rotationY: number;
  /** `armchair` senta mais alto e recostado; `floor` senta no tapete. */
  readonly kind: 'armchair' | 'floor';
}

/**
 * As poltronas primeiro. O tapete e a fileira de tras do lounge -- os pontos
 * ficam na metade sul dele porque o caminho em L entra pelo corredor da porta
 * e cruza a linha da poltrona do norte antes de chegar la em cima.
 */
export const LOUNGE_SEATS: readonly LoungeSeat[] = [
  { point: { x: 2.8, z: 2.8 }, rotationY: (3 * Math.PI) / 4, kind: 'armchair' },
  { point: { x: 5.2, z: 5.2 }, rotationY: -Math.PI / 4, kind: 'armchair' },
  { point: { x: 2.9, z: 5.3 }, rotationY: Math.atan2(1.1, -1.3), kind: 'floor' },
  { point: { x: 4.0, z: 5.5 }, rotationY: Math.PI, kind: 'floor' },
  { point: { x: 5.5, z: 4.3 }, rotationY: Math.atan2(-1.5, -0.3), kind: 'floor' },
  { point: { x: 2.6, z: 4.0 }, rotationY: Math.atan2(1.4, 0), kind: 'floor' },
];

/** Luminarias pendentes: uma sobre a baia norte, outra sobre o lounge. */
export const PENDANT_LAMPS: readonly WorldPoint[] = [
  { x: -1.2, z: -4.2 },
  { x: 4, z: 4 },
];

/** As duas janelas da parede norte: vaos reais na parede segmentada. */
export interface WindowSpot {
  readonly centerX: number;
  readonly width: number;
  readonly sillY: number;
  readonly topY: number;
}

export const WINDOWS: readonly WindowSpot[] = [
  { centerX: -2.4, width: 2.4, sillY: 0.95, topY: 2.65 },
  { centerX: 2.4, width: 2.4, sillY: 0.95, topY: 2.65 },
];

/**
 * Fileira de espera para quando ha mais agentes vivos do que mesas: encostados
 * na borda sul aberta, deixando a coluna da porta livre.
 */
export const OVERFLOW_SPOTS: readonly { readonly tile: Tile; readonly rotationY: number }[] = [
  2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13,
].map((col) => ({ tile: { col, row: 14 }, rotationY: Math.PI }));

const tileKey = (tile: Tile): string => `${tile.col},${tile.row}`;

/** Tiles que bloqueiam caminhada: mesas, cadeiras, plantas, aparador e lounge. */
export const OCCUPIED_TILES: ReadonlySet<string> = new Set([
  ...DESKS.flatMap((desk) => [tileKey(desk.tile), tileKey(desk.chair)]),
  ...PLANT_SPOTS.map((spot) => tileKey(spot.tile)),
  tileKey({ col: 0, row: 4 }),
  tileKey({ col: 0, row: 5 }),
  tileKey({ col: 0, row: 6 }),
  tileKey({ col: 10, row: 10 }),
  tileKey({ col: 11, row: 11 }),
  tileKey({ col: 13, row: 13 }),
]);

export function tileToWorld(tile: Tile): WorldPoint {
  return { x: tile.col - GRID_SIZE / 2 + 0.5, z: tile.row - GRID_SIZE / 2 + 0.5 };
}

export const DOOR_WORLD: WorldPoint = tileToWorld(DOOR);

/**
 * A coluna da porta: a unica livre da frente ao fundo da sala. Todo mundo entra
 * por ela, e quem atravessa o escritorio volta a ela antes de cortar caminho.
 */
export const CORRIDOR_X: number = DOOR.col - GRID_SIZE / 2 + 0.5;

/**
 * Por onde passar para sair de um lugar de trabalho e atravessar a sala.
 *
 * O L de `buildPath` da conta da viagem porta -> mesa, que era a unica que
 * existia. A **volta** e outra historia, e nao e detalhe: quem sai de uma mesa
 * comeca dentro da fileira de cadeiras, e descer a propria coluna atravessa os
 * colegas -- na baia oeste as tres cadeiras estao na mesma coluna, e na norte a
 * mesinha do lounge fica bem na descida.
 *
 * A regra e a de um escritorio de verdade: **saia da baia pelo corredor**. O
 * primeiro passo e o lugar em pe da propria mesa (`stand`), que ja e o vao
 * livre em frente a ela; dali o corredor, e so entao o destino.
 *
 * `exit` ausente quer dizer que a pessoa nao estava em mesa nenhuma (estava na
 * fileira de espera, ja no vao aberto); ai o corredor e alcancado direto, e
 * `from` diz de que altura.
 */
export function aisleRoute(
  exit: WorldPoint | undefined,
  from: WorldPoint,
  to: WorldPoint,
): readonly WorldPoint[] {
  const start = exit ?? from;
  return dedupe([
    ...(exit === undefined ? [] : [exit]),
    { x: CORRIDOR_X, z: start.z },
    { x: CORRIDOR_X, z: to.z },
  ]);
}

const same = (a: WorldPoint, b: WorldPoint): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;

/** Ponto repetido vira parada morta no caminho: o boneco trava um frame nele. */
function dedupe(points: readonly WorldPoint[]): WorldPoint[] {
  const out: WorldPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last === undefined || !same(last, point)) out.push(point);
  }
  return out;
}

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
 * O caminho inteiro, de onde a pessoa esta ate o destino, passando pelas
 * paradas obrigatorias. Cada trecho continua sendo um L de `buildPath`.
 */
export function buildRoute(
  from: WorldPoint,
  via: readonly WorldPoint[],
  to: WorldPoint,
): readonly WorldPoint[] {
  const points: WorldPoint[] = [];
  let current = from;
  for (const stop of [...via, to]) {
    points.push(...buildPath(current, stop));
    current = stop;
  }
  // A posicao atual entra na limpeza e sai no fim: uma parada em cima de onde o
  // boneco ja esta e um passo de tamanho zero, e ele fica um frame parado nela.
  // Acontece de verdade -- quem esta em pe na propria mesa ja esta no primeiro
  // ponto da rota de saida.
  return dedupe([from, ...points]).slice(1);
}

/**
 * Amostra o caminho tile a tile e confere se nao pisa em tile ocupado.
 *
 * Nem o tile de destino nem o de origem contam: sentar na cadeira e exatamente
 * pisar nela, e sair dela tambem. Sem a isencao da origem, todo caminho que
 * comeca numa cadeira seria recusado -- que e justamente a viagem de quem
 * termina o trabalho e vai descansar.
 */
export function pathIsClear(
  from: WorldPoint,
  to: WorldPoint,
  occupied: ReadonlySet<string> = OCCUPIED_TILES,
): boolean {
  const points: WorldPoint[] = [from, ...buildPath(from, to)];
  const destinationKey = `${Math.floor(to.x + GRID_SIZE / 2)},${Math.floor(to.z + GRID_SIZE / 2)}`;
  const originKey = `${Math.floor(from.x + GRID_SIZE / 2)},${Math.floor(from.z + GRID_SIZE / 2)}`;

  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const a = points[segment];
    const b = points[segment + 1];
    if (a === undefined || b === undefined) return false;

    const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z)) * 2);
    for (let step = 1; step <= steps; step += 1) {
      const x = a.x + ((b.x - a.x) * step) / steps;
      const z = a.z + ((b.z - a.z) * step) / steps;
      const key = `${Math.floor(x + GRID_SIZE / 2)},${Math.floor(z + GRID_SIZE / 2)}`;
      if (key === destinationKey || key === originKey) continue;
      if (occupied.has(key)) return false;
    }
  }
  return true;
}
