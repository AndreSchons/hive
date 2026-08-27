import { useRef, type ComponentRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { ContactShadows, OrbitControls } from '@react-three/drei';
import { MOUSE } from 'three';
import { AgentCharacters } from './characters/AgentCharacters';
import { Floor } from './office/Floor';
import { Furniture } from './office/Furniture';
import { Walls } from './office/Walls';
import { Lights } from './Lights';
import { BACKGROUND } from './office/palette';

// Camera ortografica em angulo fixo: ~35 graus de elevacao, 45 de azimute.
const CAMERA_DISTANCE = 30;
const ELEVATION = (35 * Math.PI) / 180;
const AZIMUTH = Math.PI / 4;
const cameraPosition: [number, number, number] = [
  Math.cos(ELEVATION) * Math.sin(AZIMUTH) * CAMERA_DISTANCE,
  Math.sin(ELEVATION) * CAMERA_DISTANCE,
  Math.cos(ELEVATION) * Math.cos(AZIMUTH) * CAMERA_DISTANCE,
];

const PAN_LIMIT = 7;
const clampPan = (value: number): number => Math.min(Math.max(value, -PAN_LIMIT), PAN_LIMIT);

/**
 * O escritorio. Este modulo nao conhece agente, CLI nem modelo: desenha o
 * estado do mundo derivado dos eventos, e so isso.
 */
export function Scene() {
  const controls = useRef<ComponentRef<typeof OrbitControls> | null>(null);

  return (
    <Canvas
      dpr={[1, 2]}
      orthographic
      camera={{ position: cameraPosition, zoom: 40, near: -100, far: 200 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[BACKGROUND]} />

      <Lights />
      <Floor />
      <Walls />
      <Furniture />
      <AgentCharacters />

      {/* Sombra de contato em vez de shadow map: mais barata e combina com o visual. */}
      <ContactShadows
        position={[0, 0.02, 0]}
        scale={22}
        far={6}
        resolution={512}
        blur={2.2}
        opacity={0.35}
        color="#8A7A63"
      />

      <OrbitControls
        ref={controls}
        makeDefault
        // Sem rotacao livre: o enquadramento isometrico e fixo. Zoom no
        // scroll, pan (botao esquerdo ou direito) com limites da sala.
        enableRotate={false}
        mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
        minZoom={20}
        maxZoom={95}
        onChange={() => {
          const current = controls.current;
          if (current === null) return;
          current.target.x = clampPan(current.target.x);
          current.target.z = clampPan(current.target.z);
          current.target.y = 0;
        }}
      />
    </Canvas>
  );
}
