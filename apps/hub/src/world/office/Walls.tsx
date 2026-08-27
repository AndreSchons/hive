import { Instances, type InstanceItem } from './Instances';
import { GRID_SIZE, WALL_HEIGHT, WALL_THICKNESS, WINDOWS, tileToWorld } from './layout';
import { WALL_NORTH, WALL_WEST, WOOD_DARK } from './palette';
import { ToonMaterial } from './toon';

const EDGE = GRID_SIZE / 2;
const wallZ = tileToWorld({ col: 0, row: 0 }).z;
const wallX = tileToWorld({ col: 0, row: 0 }).x;

// A parede norte e segmentada para abrir os vaos das janelas: um pe-direito
// entre vaos, uma faixa embaixo (peitoril) e uma em cima de cada janela.
const northSegments: InstanceItem[] = [];
{
  const box = (centerX: number, centerY: number, width: number, height: number): InstanceItem => ({
    position: [centerX, centerY, wallZ],
    scale: [width, height, WALL_THICKNESS],
  });

  let cursor = -EDGE;
  for (const win of [...WINDOWS].sort((a, b) => a.centerX - b.centerX)) {
    const left = win.centerX - win.width / 2;
    const right = win.centerX + win.width / 2;
    northSegments.push(box((cursor + left) / 2, WALL_HEIGHT / 2, left - cursor, WALL_HEIGHT));
    northSegments.push(box(win.centerX, win.sillY / 2, win.width, win.sillY));
    const topHeight = WALL_HEIGHT - win.topY;
    northSegments.push(box(win.centerX, win.topY + topHeight / 2, win.width, topHeight));
    cursor = right;
  }
  northSegments.push(box((cursor + EDGE) / 2, WALL_HEIGHT / 2, EDGE - cursor, WALL_HEIGHT));
}

/**
 * As paredes de fundo do diorama: norte (com os vaos das janelas) e oeste em
 * altura cheia, formando um L, com rodape escuro nas duas. A frente (sul e
 * leste) fica aberta para a camera -- e por isso nenhum personagem fica
 * escondido atras de parede.
 */
export function Walls() {
  return (
    <group>
      <Instances items={northSegments}>
        <boxGeometry args={[1, 1, 1]} />
        <ToonMaterial color={WALL_NORTH} />
      </Instances>

      <mesh position={[wallX, WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, GRID_SIZE]} />
        <ToonMaterial color={WALL_WEST} />
      </mesh>

      {/* Rodape escuro na base das duas paredes. */}
      <mesh position={[0, 0.09, wallZ + 0.02]}>
        <boxGeometry args={[GRID_SIZE, 0.18, WALL_THICKNESS + 0.08]} />
        <ToonMaterial color={WOOD_DARK} />
      </mesh>
      <mesh position={[wallX + 0.02, 0.09, 0]}>
        <boxGeometry args={[WALL_THICKNESS + 0.08, 0.18, GRID_SIZE]} />
        <ToonMaterial color={WOOD_DARK} />
      </mesh>
    </group>
  );
}
