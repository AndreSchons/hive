import { DoubleSide, Mesh } from 'three';
import { WALL_THICKNESS, WINDOWS, tileToWorld, type WindowSpot } from './layout';
import { CREAM } from './palette';
import { OVERLAY_LAYER, ToonMaterial } from './toon';

const wallZ = tileToWorld({ col: 0, row: 0 }).z;

/** Vidro, ceu e cidade sao overlays: nao imprimem mancha na sombra de contato. */
const setOverlay = (mesh: Mesh | null): void => {
  if (mesh !== null) mesh.layers.set(OVERLAY_LAYER);
};

// Silhueta da cidade atras do vidro: caixas planas em tons de azul claro,
// sem detalhe nenhum. Nao e skybox, e recorte.
const CITY_TONES = ['#8FB8DE', '#A9CBE8', '#7AA7D4'] as const;
const BUILDINGS: readonly { readonly dx: number; readonly w: number; readonly h: number; readonly tone: number }[] = [
  { dx: -0.92, w: 0.5, h: 1.1, tone: 0 },
  { dx: -0.42, w: 0.38, h: 0.75, tone: 1 },
  { dx: 0.02, w: 0.55, h: 1.35, tone: 2 },
  { dx: 0.52, w: 0.34, h: 0.9, tone: 1 },
  { dx: 0.92, w: 0.44, h: 1.15, tone: 0 },
];

function WindowUnit({ spot }: { readonly spot: WindowSpot }) {
  const height = spot.topY - spot.sillY;
  const midY = (spot.sillY + spot.topY) / 2;
  const proud = WALL_THICKNESS / 2 + 0.02;

  return (
    <group position={[spot.centerX, 0, wallZ]}>
      {/* O ceu fica colado atras da parede: a camera a 28° enxerga por cima do
          muro, entao o topo do plano precisa ficar abaixo da linha de visada
          que passa pela testada da parede (~2.79 nessa profundidade). */}
      <mesh ref={setOverlay} position={[0, 1.59, -0.42]}>
        <planeGeometry args={[spot.width + 1.6, 2.18]} />
        <meshBasicMaterial color="#CFE6F5" />
      </mesh>

      {BUILDINGS.map((building) => (
        <mesh
          key={building.dx}
          ref={setOverlay}
          position={[building.dx, spot.sillY + building.h / 2, -0.35]}
        >
          <boxGeometry args={[building.w, building.h, 0.16]} />
          <meshBasicMaterial color={CITY_TONES[building.tone] ?? CITY_TONES[0]} />
        </mesh>
      ))}

      <mesh ref={setOverlay} position={[0, midY, 0]}>
        <planeGeometry args={[spot.width, height]} />
        <meshBasicMaterial color="#EAF6FF" transparent opacity={0.22} depthWrite={false} side={DoubleSide} />
      </mesh>

      {/* Moldura clara: batente, travessas e peitoril. */}
      <mesh position={[0, spot.topY, proud]}>
        <boxGeometry args={[spot.width + 0.12, 0.1, 0.14]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[0, spot.sillY, proud]}>
        <boxGeometry args={[spot.width + 0.12, 0.1, 0.14]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[-spot.width / 2, midY, proud]}>
        <boxGeometry args={[0.1, height + 0.1, 0.14]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[spot.width / 2, midY, proud]}>
        <boxGeometry args={[0.1, height + 0.1, 0.14]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[0, midY, proud]}>
        <boxGeometry args={[0.06, height, 0.1]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[0, midY, proud]}>
        <boxGeometry args={[spot.width, 0.06, 0.1]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[0, spot.sillY - 0.07, proud + 0.04]}>
        <boxGeometry args={[spot.width + 0.24, 0.06, 0.26]} />
        <ToonMaterial color={CREAM} />
      </mesh>
    </group>
  );
}

/** As duas janelas grandes da parede norte. */
export function Windows() {
  return (
    <group>
      {WINDOWS.map((spot) => (
        <WindowUnit key={spot.centerX} spot={spot} />
      ))}
    </group>
  );
}
