import { WALL_THICKNESS, tileToWorld } from './layout';
import { CREAM, MUSTARD, SCREEN, TERRACOTTA, UPHOLSTERY_BLUE, WOOD_DARK } from './palette';
import { ToonMaterial } from './toon';

const wallZ = tileToWorld({ col: 0, row: 0 }).z;
const wallX = tileToWorld({ col: 0, row: 0 }).x;
const proud = WALL_THICKNESS / 2;

/** Relogio redondo na parede norte, entre as janelas. Marcando 10:10, claro. */
function Clock() {
  const hourAngle = ((10 + 10 / 60) / 12) * Math.PI * 2;
  const minuteAngle = (10 / 60) * Math.PI * 2;

  return (
    <group position={[0, 2.02, wallZ + proud]}>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.03]}>
        <cylinderGeometry args={[0.3, 0.3, 0.06, 24]} />
        <ToonMaterial color={WOOD_DARK} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.045]}>
        <cylinderGeometry args={[0.26, 0.26, 0.06, 24]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      {/* Ponteiros: caixas finas giradas no plano do mostrador. */}
      <mesh
        position={[Math.sin(hourAngle) * 0.05, Math.cos(hourAngle) * 0.05, 0.09]}
        rotation={[0, 0, -hourAngle]}
      >
        <boxGeometry args={[0.03, 0.12, 0.015]} />
        <ToonMaterial color={SCREEN} />
      </mesh>
      <mesh
        position={[Math.sin(minuteAngle) * 0.07, Math.cos(minuteAngle) * 0.07, 0.09]}
        rotation={[0, 0, -minuteAngle]}
      >
        <boxGeometry args={[0.02, 0.17, 0.015]} />
        <ToonMaterial color={SCREEN} />
      </mesh>
    </group>
  );
}

interface PaintingProps {
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly width: number;
  readonly height: number;
  readonly field: string;
  readonly accent: string;
}

/** Quadro retangular de cor chapada: moldura escura, campo e um recorte. */
function Painting({ position, rotationY, width, height, field, accent }: PaintingProps) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[width, height, 0.06]} />
        <ToonMaterial color={WOOD_DARK} />
      </mesh>
      <mesh position={[0, 0, 0.035]}>
        <planeGeometry args={[width - 0.16, height - 0.16]} />
        <ToonMaterial color={field} />
      </mesh>
      <mesh position={[width * 0.14, -height * 0.08, 0.045]}>
        <planeGeometry args={[width * 0.38, height * 0.42]} />
        <ToonMaterial color={accent} />
      </mesh>
    </group>
  );
}

/** Relogio entre as janelas e um quadro em cada parede. */
export function WallDecor() {
  return (
    <group>
      <Clock />
      <Painting
        position={[5.5, 1.85, wallZ + proud + 0.03]}
        rotationY={0}
        width={1.3}
        height={1}
        field={TERRACOTTA}
        accent={MUSTARD}
      />
      <Painting
        position={[wallX + proud + 0.03, 2, -2]}
        rotationY={Math.PI / 2}
        width={1.1}
        height={0.9}
        field={UPHOLSTERY_BLUE}
        accent={CREAM}
      />
    </group>
  );
}
