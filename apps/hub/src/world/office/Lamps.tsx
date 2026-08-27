import { PENDANT_LAMPS } from './layout';
import { CREAM, LAMP_DARK } from './palette';
import { ToonMaterial } from './toon';

const DOME_Y = 2.55;

/**
 * Luminarias pendentes: cupula retangular escura com um plano emissivo claro
 * embaixo, pendurada por um cabo fino que sai do quadro (o diorama nao tem
 * teto -- o cabo some para cima).
 */
export function Lamps() {
  return (
    <group>
      {PENDANT_LAMPS.map((lamp) => (
        <group key={`${lamp.x},${lamp.z}`} position={[lamp.x, 0, lamp.z]}>
          <mesh position={[0, (DOME_Y + 4.4) / 2, 0]}>
            <cylinderGeometry args={[0.015, 0.015, 4.4 - DOME_Y, 6]} />
            <ToonMaterial color={LAMP_DARK} />
          </mesh>
          <mesh position={[0, DOME_Y, 0]}>
            <boxGeometry args={[0.7, 0.35, 0.5]} />
            <ToonMaterial color={LAMP_DARK} />
          </mesh>
          <mesh position={[0, DOME_Y - 0.19, 0]}>
            <boxGeometry args={[0.74, 0.05, 0.54]} />
            <ToonMaterial color={LAMP_DARK} />
          </mesh>
          {/* O plano emissivo: a luz que a cena finge vir da luminaria. */}
          <mesh position={[0, DOME_Y - 0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.6, 0.4]} />
            <meshBasicMaterial color={CREAM} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
