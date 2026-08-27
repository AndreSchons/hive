import { Instances, type InstanceItem } from './Instances';
import { DOOR, DOOR_WORLD, GRID_SIZE, tileToWorld } from './layout';
import { FLOOR_A, FLOOR_B, FURNITURE } from './palette';

// Padrao xadrez dos tiles, calculado uma vez: sao dados fixos do layout.
const evenTiles: InstanceItem[] = [];
const oddTiles: InstanceItem[] = [];
for (let col = 0; col < GRID_SIZE; col += 1) {
  for (let row = 0; row < GRID_SIZE; row += 1) {
    const { x, z } = tileToWorld({ col, row });
    const item: InstanceItem = { position: [x, -0.05, z] };
    if ((col + row) % 2 === 0) evenTiles.push(item);
    else oddTiles.push(item);
  }
}

/** Chao do escritorio: tiles alternados e o tile da porta marcado. */
export function Floor() {
  return (
    <group>
      <Instances items={evenTiles}>
        <boxGeometry args={[0.96, 0.1, 0.96]} />
        <meshLambertMaterial color={FLOOR_A} />
      </Instances>
      <Instances items={oddTiles}>
        <boxGeometry args={[0.96, 0.1, 0.96]} />
        <meshLambertMaterial color={FLOOR_B} />
      </Instances>

      {/* O tapete da porta: onde todo personagem aparece. */}
      <mesh position={[DOOR_WORLD.x, -0.04, DOOR_WORLD.z]}>
        <boxGeometry args={[0.9, 0.12, 0.9]} />
        <meshLambertMaterial color={FURNITURE} />
      </mesh>
    </group>
  );
}

export { DOOR };
