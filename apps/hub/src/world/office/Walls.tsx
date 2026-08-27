import { WALL_HEIGHT, WALL_THICKNESS, GRID_SIZE, tileToWorld } from './layout';
import { WALL_NORTH, WALL_WEST } from './palette';
import { ToonMaterial } from './toon';

/**
 * As paredes de fundo do diorama: norte e oeste em altura cheia, formando um
 * L. A frente (sul e leste) fica aberta para a camera -- e por isso nenhum
 * personagem fica escondido atras de parede. Janelas, rodape e decoracao
 * entram na etapa seguinte.
 */
export function Walls() {
  const north = tileToWorld({ col: 0, row: 0 });
  const west = tileToWorld({ col: 0, row: 0 });

  return (
    <group>
      <mesh position={[0, WALL_HEIGHT / 2, north.z]}>
        <boxGeometry args={[GRID_SIZE, WALL_HEIGHT, WALL_THICKNESS]} />
        <ToonMaterial color={WALL_NORTH} />
      </mesh>
      <mesh position={[west.x, WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, GRID_SIZE]} />
        <ToonMaterial color={WALL_WEST} />
      </mesh>
    </group>
  );
}
