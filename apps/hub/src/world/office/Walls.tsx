import { Instances, type InstanceItem } from './Instances';
import { DOOR, GRID_SIZE, tileToWorld } from './layout';
import { WALL } from './palette';

const WALL_HEIGHT = 0.45;

// Paredes baixas nas quatro bordas, com vao na porta. Baixas o bastante para
// nunca cortarem a visao da camera isometrica. Os cantos ficam com as
// paredes norte/sul; leste e oeste param um tile antes.
const wallItems: InstanceItem[] = [];
for (let col = 0; col < GRID_SIZE; col += 1) {
  const north = tileToWorld({ col, row: 0 });
  wallItems.push({ position: [north.x, WALL_HEIGHT / 2, north.z] });

  if (col !== DOOR.col) {
    const south = tileToWorld({ col, row: GRID_SIZE - 1 });
    wallItems.push({ position: [south.x, WALL_HEIGHT / 2, south.z] });
  }
}
for (let row = 1; row < GRID_SIZE - 1; row += 1) {
  const west = tileToWorld({ col: 0, row });
  wallItems.push({ position: [west.x, WALL_HEIGHT / 2, west.z], rotationY: Math.PI / 2 });
  const east = tileToWorld({ col: GRID_SIZE - 1, row });
  wallItems.push({ position: [east.x, WALL_HEIGHT / 2, east.z], rotationY: Math.PI / 2 });
}

/** Murinhos da borda. Uma unica draw call para as 59 pecas. */
export function Walls() {
  return (
    <Instances items={wallItems}>
      <boxGeometry args={[1.04, WALL_HEIGHT, 0.3]} />
      <meshLambertMaterial color={WALL} />
    </Instances>
  );
}
