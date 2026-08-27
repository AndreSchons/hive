import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Mesh, MeshBasicMaterial } from 'three';
import { PUFF } from '../office/palette';
import { OVERLAY_LAYER } from '../office/toon';

interface Particle {
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  readonly spread: number;
  readonly size: number;
  readonly delay: number;
  readonly duration: number;
}

interface SpawnPuffProps {
  /** `in` expande do centro; `out` e a mesma animacao ao contrario (despawn). */
  readonly mode: 'in' | 'out';
}

/**
 * A fumaca do spawn/despawn: 8 a 12 esferas brancas que nascem no ponto,
 * expandem com ease-out subindo um pouco e somem em ~600ms. Escalas e atrasos
 * levemente aleatorios para nao parecer mecanico -- aleatorio so na
 * apresentacao, gerado uma vez por puff, nunca no estado do mundo.
 *
 * Toca sozinha ao montar e se esconde ao terminar; quem monta/desmonta e o
 * Character.
 */
export function SpawnPuff({ mode }: SpawnPuffProps) {
  const group = useRef<Group>(null!);
  const meshes = useRef<(Mesh | null)[]>([]);
  const clock = useRef(0);
  const finished = useRef(false);

  const particles = useMemo<readonly Particle[]>(() => {
    const count = 8 + Math.floor(Math.random() * 5);
    return Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      return {
        dirX: Math.cos(angle),
        dirY: 0.25 + Math.random() * 0.5,
        dirZ: Math.sin(angle),
        spread: 0.45 + Math.random() * 0.45,
        size: 0.1 + Math.random() * 0.12,
        delay: Math.random() * 120,
        duration: 420 + Math.random() * 180,
      };
    });
  }, []);

  useFrame((_, deltaRaw) => {
    if (finished.current) return;
    clock.current += Math.min(deltaRaw, 0.05) * 1000;

    let alive = false;
    particles.forEach((particle, index) => {
      const mesh = meshes.current[index];
      if (mesh === null || mesh === undefined) return;

      const t = Math.min(Math.max((clock.current - particle.delay) / particle.duration, 0), 1);
      if (t < 1) alive = true;

      const k = mode === 'in' ? t : 1 - t;
      const eased = 1 - Math.pow(1 - k, 3);
      mesh.position.set(
        particle.dirX * eased * particle.spread,
        0.35 + particle.dirY * eased * particle.spread + t * 0.2,
        particle.dirZ * eased * particle.spread,
      );
      mesh.scale.setScalar(particle.size * (0.55 + 0.45 * eased));

      const material = mesh.material;
      if (material instanceof MeshBasicMaterial) {
        material.opacity = 0.9 * (1 - t);
      }
    });

    if (!alive) {
      finished.current = true;
      group.current.visible = false;
    }
  });

  return (
    <group ref={group}>
      {particles.map((_, index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            meshes.current[index] = mesh;
            // Fumaca e overlay: nao pode imprimir mancha na sombra de contato.
            if (mesh !== null) mesh.layers.set(OVERLAY_LAYER);
          }}
        >
          <sphereGeometry args={[1, 12, 10]} />
          <meshBasicMaterial color={PUFF} transparent opacity={0.9} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
