import { useMemo } from 'react';
import { DoubleSide, PlaneGeometry } from 'three';
import { Instances, type InstanceItem } from './Instances';
import { PLANT_SPOTS, SIDEBOARD, tileToWorld } from './layout';
import { PLANT, TERRACOTTA } from './palette';
import { ToonMaterial } from './toon';

/**
 * Folha alongada e levemente curva, com a base na origem para girar em leque.
 * Geometria compartilhada por todas as plantas da cena.
 */
function buildLeafGeometry(): PlaneGeometry {
  const geometry = new PlaneGeometry(0.16, 0.7, 1, 6);
  const position = geometry.attributes['position'];
  if (position !== undefined) {
    for (let index = 0; index < position.count; index += 1) {
      const y = position.getY(index);
      const t = (y + 0.35) / 0.7;
      // Curva para fora subindo e afina ate a ponta.
      position.setZ(index, Math.sin(t * Math.PI * 0.85) * 0.13);
      position.setX(index, position.getX(index) * (1 - t * 0.75));
    }
    geometry.computeVertexNormals();
  }
  geometry.translate(0, 0.35, 0);
  return geometry;
}

interface PlantSpot {
  readonly x: number;
  readonly z: number;
  readonly scale: number;
}

const FLOOR_PLANTS: readonly PlantSpot[] = PLANT_SPOTS.map((spot) => ({
  ...tileToWorld(spot.tile),
  scale: spot.scale,
}));

/** A plantinha do aparador, em cima do tampo. */
const SIDEBOARD_PLANT: PlantSpot = { x: SIDEBOARD.center.x, z: SIDEBOARD.center.z - 0.6, scale: 0.4 };
const SIDEBOARD_TOP_Y = 0.65;

const LEAVES_PER_PLANT = 6;

/** Vasos de terracota e folhas curvas: tres tamanhos, mais a do aparador. */
export function Plants() {
  const leafGeometry = useMemo(buildLeafGeometry, []);

  const { pots, leaves } = useMemo(() => {
    const potItems: InstanceItem[] = [];
    const leafItems: InstanceItem[] = [];
    const plants = [...FLOOR_PLANTS, SIDEBOARD_PLANT];

    plants.forEach((plant, plantIndex) => {
      const baseY = plant === SIDEBOARD_PLANT ? SIDEBOARD_TOP_Y : 0;
      potItems.push({
        position: [plant.x, baseY + 0.17 * plant.scale, plant.z],
        scale: [plant.scale, plant.scale, plant.scale],
      });
      for (let leaf = 0; leaf < LEAVES_PER_PLANT; leaf += 1) {
        const angle = (leaf / LEAVES_PER_PLANT) * Math.PI * 2 + plantIndex * 0.5;
        leafItems.push({
          position: [plant.x, baseY + 0.3 * plant.scale, plant.z],
          rotationY: angle,
          rotationX: 0.45,
          scale: [plant.scale, plant.scale, plant.scale],
        });
      }
    });

    return { pots: potItems, leaves: leafItems };
  }, []);

  return (
    <group>
      <Instances items={pots}>
        <cylinderGeometry args={[0.2, 0.27, 0.36, 12]} />
        <ToonMaterial color={TERRACOTTA} />
      </Instances>
      <Instances items={leaves}>
        <primitive object={leafGeometry} attach="geometry" />
        <ToonMaterial color={PLANT} side={DoubleSide} />
      </Instances>
    </group>
  );
}
