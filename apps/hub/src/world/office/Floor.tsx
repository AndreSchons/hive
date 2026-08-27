import { Instances, type InstanceItem } from './Instances';
import { DOOR, DOOR_WORLD, GRID_SIZE, tileToWorld } from './layout';
import { FLOOR_A, FLOOR_B, TERRACOTTA, WOOD_DARK } from './palette';
import { ToonMaterial } from './toon';

// Tabuas de madeira: o tom alterna por fileira, calculado uma vez -- sao
// dados fixos do layout.
const evenRows: InstanceItem[] = [];
const oddRows: InstanceItem[] = [];
for (let col = 0; col < GRID_SIZE; col += 1) {
  for (let row = 0; row < GRID_SIZE; row += 1) {
    const { x, z } = tileToWorld({ col, row });
    const item: InstanceItem = { position: [x, -0.05, z] };
    if (row % 2 === 0) evenRows.push(item);
    else oddRows.push(item);
  }
}

/** Chao do diorama: tabuas claras, saia escura embaixo e o tapete da porta. */
export function Floor() {
  return (
    <group>
      <Instances items={evenRows}>
        <boxGeometry args={[0.98, 0.1, 0.98]} />
        <ToonMaterial color={FLOOR_A} />
      </Instances>
      <Instances items={oddRows}>
        <boxGeometry args={[0.98, 0.1, 0.98]} />
        <ToonMaterial color={FLOOR_B} />
      </Instances>

      {/* A saia da maquete: o chao tem espessura e a borda fica escura. */}
      <mesh position={[0, -0.275, 0]}>
        <boxGeometry args={[GRID_SIZE + 0.6, 0.35, GRID_SIZE + 0.6]} />
        <ToonMaterial color={WOOD_DARK} />
      </mesh>

      {/* O tapete da porta: onde todo personagem aparece. */}
      <mesh position={[DOOR_WORLD.x, -0.04, DOOR_WORLD.z]}>
        <boxGeometry args={[0.9, 0.12, 0.9]} />
        <ToonMaterial color={TERRACOTTA} />
      </mesh>
    </group>
  );
}

export { DOOR };
