import { Grid } from '@react-three/drei';

export interface GridFloorProps {
  readonly size?: number;
}

/** Chao do escritorio. As mesas e os personagens entram por cima, depois. */
export function GridFloor({ size = 28 }: GridFloorProps) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color="#111a29" roughness={0.95} metalness={0.05} />
      </mesh>

      <Grid
        args={[size, size]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#1d2b40"
        sectionSize={4}
        sectionThickness={1.1}
        sectionColor="#2d4463"
        fadeDistance={38}
        fadeStrength={1.2}
        followCamera={false}
        infiniteGrid={false}
      />
    </group>
  );
}
