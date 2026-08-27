import { LOUNGE } from './layout';
import { CREAM, MUSTARD, RUG, RUG_DARK, UPHOLSTERY_BLUE, UPHOLSTERY_GREEN, WOOD, WOOD_DARK } from './palette';
import { ToonMaterial } from './toon';

const ARMCHAIR_COLORS = [UPHOLSTERY_GREEN, UPHOLSTERY_BLUE] as const;

function Armchair({
  center,
  rotationY,
  color,
}: {
  readonly center: { readonly x: number; readonly z: number };
  readonly rotationY: number;
  readonly color: string;
}) {
  return (
    <group position={[center.x, 0, center.z]} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.28, 0]}>
        <boxGeometry args={[0.7, 0.25, 0.65]} />
        <ToonMaterial color={color} />
      </mesh>
      <mesh position={[0, 0.52, -0.28]}>
        <boxGeometry args={[0.7, 0.55, 0.18]} />
        <ToonMaterial color={color} />
      </mesh>
      {[-0.32, 0.32].map((x) => (
        <mesh key={x} position={[x, 0.44, 0]}>
          <boxGeometry args={[0.15, 0.3, 0.6]} />
          <ToonMaterial color={color} />
        </mesh>
      ))}
    </group>
  );
}

/** O lounge do canto sudeste: tapete com borda, duas poltronas e a mesinha. */
export function Lounge() {
  const { rug, armchairs, coffeeTable } = LOUNGE;

  return (
    <group>
      {/* Tapete retangular com borda mais escura. */}
      <mesh position={[rug.center.x, 0.015, rug.center.z]}>
        <boxGeometry args={[rug.size + 0.3, 0.03, rug.size + 0.3]} />
        <ToonMaterial color={RUG_DARK} />
      </mesh>
      <mesh position={[rug.center.x, 0.03, rug.center.z]}>
        <boxGeometry args={[rug.size, 0.04, rug.size]} />
        <ToonMaterial color={RUG} />
      </mesh>

      {armchairs.map((armchair, index) => (
        <Armchair
          key={`${armchair.center.x},${armchair.center.z}`}
          center={armchair.center}
          rotationY={armchair.rotationY}
          color={ARMCHAIR_COLORS[index % ARMCHAIR_COLORS.length] ?? UPHOLSTERY_GREEN}
        />
      ))}

      {/* Mesinha de centro com um livro e uma caneca. */}
      <group position={[coffeeTable.center.x, 0, coffeeTable.center.z]}>
        <mesh position={[0, 0.32, 0]}>
          <boxGeometry args={[0.9, 0.06, 0.6]} />
          <ToonMaterial color={WOOD} />
        </mesh>
        {[-0.38, 0.38].map((x) => (
          <mesh key={x} position={[x, 0.15, 0]}>
            <boxGeometry args={[0.06, 0.3, 0.5]} />
            <ToonMaterial color={WOOD_DARK} />
          </mesh>
        ))}
        <mesh position={[0.18, 0.38, 0.08]} rotation={[0, 0.4, 0]}>
          <boxGeometry args={[0.22, 0.05, 0.16]} />
          <ToonMaterial color={MUSTARD} />
        </mesh>
        <mesh position={[-0.22, 0.4, -0.05]}>
          <cylinderGeometry args={[0.05, 0.05, 0.1, 12]} />
          <ToonMaterial color={CREAM} />
        </mesh>
      </group>
    </group>
  );
}
