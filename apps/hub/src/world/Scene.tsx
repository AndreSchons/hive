import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { GridFloor } from './GridFloor';
import { Lights } from './Lights';

/**
 * O escritorio. Por enquanto so o chao, a luz e a camera: sem personagens.
 *
 * Este modulo nao conhece agente, CLI nem modelo -- quando os personagens
 * entrarem, eles vao ler o estado do mundo (que e derivado de eventos) e nunca
 * o orquestrador.
 */
export function Scene() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      // Camera ortografica em angulo isometrico: sem perspectiva, o escritorio
      // le como planta baixa e o tamanho do personagem nao depende da distancia.
      orthographic
      camera={{ position: [18, 18, 18], zoom: 42, near: -100, far: 200 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={['#0b0f17']} />
      <fog attach="fog" args={['#0b0f17', 34, 68]} />

      <Lights />
      <GridFloor />

      <OrbitControls
        makeDefault
        enablePan={false}
        // Trava a inclinacao: girar em torno do eixo vertical mantem o
        // enquadramento isometrico, deitar a camera destruiria.
        minPolarAngle={Math.PI / 5}
        maxPolarAngle={Math.PI / 3.2}
        minZoom={22}
        maxZoom={90}
      />
    </Canvas>
  );
}
