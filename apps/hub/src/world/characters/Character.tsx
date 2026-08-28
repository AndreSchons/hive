import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group } from 'three';
import type { Placement } from '../office/placements';
import { buildPath, buildRoute, DOOR_WORLD, type WorldPoint } from '../office/layout';
import { billboardAnchor } from '../camera';
import { DARK } from '../office/palette';
import { OVERLAY_LAYER, ToonMaterial } from '../office/toon';
import { SpawnPuff } from './SpawnPuff';
import { ThoughtBubble } from './ThoughtBubble';

/** Duracao da fumaca e do squash na entrada. */
export const SPAWN_MS = 600;

const WALK_SPEED = 2.2;
/** Quanto o corpo sobe para sentar na cadeira (o boneco nao tem pernas). */
const SEAT_LIFT = 0.12;
/**
 * A poltrona e um pouco mais alta que a cadeira de trabalho: o assento dela
 * termina em 0,405 e a almofada da cadeira em 0,385. Os dois centimetros de
 * diferenca entram aqui -- errar isso deixa o boneco boiando acima do estofado.
 */
const ARMCHAIR_LIFT = SEAT_LIFT + 0.02;
/**
 * Sentar no tapete e descer. Sem pernas, a altura e a unica coisa que separa
 * "sentado no chao" de "em pe": a calca afunda no tapete e o que sobra a vista
 * e o tronco, que e como um chibi senta. Mais fundo que isto e a camisa que
 * comeca a raspar o tapete.
 */
const FLOOR_SIT = -0.12;
/** A nuvem de pensamento: ao lado da cabeca (topo em y 1.16) e um pouco acima. */
const BUBBLE_RADIUS = 0.62;
const BUBBLE_HEIGHT = 1.85;
/** Pose da ancora antes do primeiro frame, com o personagem ainda sem girar. */
const INITIAL_ANCHOR = billboardAnchor(0, BUBBLE_RADIUS, BUBBLE_HEIGHT);

type Phase = 'spawning' | 'active';
type AnimMode = Placement['anim'] | 'walk';

interface Pose {
  y: number;
  leanX: number;
  swayZ: number;
  armL: number;
  armR: number;
  headTilt: number;
}

interface Rig {
  phase: Phase;
  /** Milissegundos dentro do spawn/despawn. */
  clock: number;
  /** Segundos acumulados, base dos ciclos de animacao. */
  anim: number;
  x: number;
  z: number;
  waypoints: WorldPoint[];
  targetRot: number;
  mode: AnimMode;
  pose: Pose;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Escala Y do squash and stretch: 0.2 -> 1.15 -> assenta em 1.0. */
function squashScale(t: number): number {
  if (t < 0.58) return 0.2 + 0.95 * easeOutCubic(t / 0.58);
  const u = (t - 0.58) / 0.42;
  return 1.15 - 0.15 * (u * u * (3 - 2 * u));
}

const damp = (current: number, target: number, lambda: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const full = Math.PI * 2;
  const diff = ((target - current + Math.PI) % full + full) % full - Math.PI;
  return current + diff * (1 - Math.exp(-lambda * dt));
}

/** Pose alvo de cada modo; o frame amortiza a transicao entre elas. */
function poseFor(mode: AnimMode, t: number): Pose {
  switch (mode) {
    case 'walk': {
      const swing = Math.sin(t * 9);
      return { y: Math.abs(swing) * 0.055, leanX: 0.14, swayZ: 0, armL: swing * 0.55, armR: -swing * 0.55, headTilt: 0 };
    }
    case 'type':
      return {
        y: SEAT_LIFT,
        leanX: 0.18,
        swayZ: 0,
        armL: -0.75 + Math.sin(t * 11) * 0.09,
        armR: -0.75 + Math.sin(t * 11 + Math.PI) * 0.09,
        headTilt: 0.06,
      };
    case 'think':
      return { y: Math.sin(t * 1.1) * 0.012, leanX: 0, swayZ: Math.sin(t * 0.8) * 0.02, armL: 0, armR: 0, headTilt: Math.sin(t * 0.7) * 0.08 };
    case 'idle':
      return { y: Math.sin(t * 2) * 0.02, leanX: 0, swayZ: Math.sin(t * 1.3) * 0.03, armL: 0, armR: 0, headTilt: 0 };
    case 'armchair':
      // Recostado na poltrona, bracos nos apoios. Tudo mais lento que o idle em
      // pe: e o que faz olhar para o lounge e ver descanso, nao espera.
      return {
        y: ARMCHAIR_LIFT + Math.sin(t * 1.4) * 0.012,
        leanX: -0.13,
        swayZ: Math.sin(t * 0.9) * 0.015,
        armL: -0.28,
        armR: -0.28,
        headTilt: Math.sin(t * 0.6) * 0.05,
      };
    case 'floor':
      // No tapete, apoiado nos bracos atras -- que e como se senta no chao sem
      // ter pernas para cruzar.
      return {
        y: FLOOR_SIT + Math.sin(t * 1.4) * 0.01,
        leanX: -0.2,
        swayZ: Math.sin(t * 0.8) * 0.02,
        armL: 0.5,
        armR: 0.5,
        headTilt: Math.sin(t * 0.5) * 0.06,
      };
  }
}

interface CharacterProps {
  readonly placement: Placement;
}

/** Cabelo por estilo, em coordenadas da cabeca (raio 0.3, frente +z). */
function Hair({ style, color }: { readonly style: number; readonly color: string }) {
  const cap = (
    <mesh position={[0, 0.09, -0.03]} scale={[1.06, 0.78, 1.06]}>
      <sphereGeometry args={[0.3, 20, 14]} />
      <ToonMaterial color={color} />
    </mesh>
  );

  switch (style) {
    case 1:
      // Curto, rente ao topo da cabeca.
      return (
        <mesh position={[0, 0.17, -0.01]} scale={[1.02, 0.55, 1.02]}>
          <sphereGeometry args={[0.3, 20, 14]} />
          <ToonMaterial color={color} />
        </mesh>
      );
    case 2:
      // Franja lateral caindo na testa.
      return (
        <group>
          {cap}
          <mesh position={[0.16, 0.14, 0.16]} scale={[1, 0.7, 1]}>
            <sphereGeometry args={[0.12, 12, 10]} />
            <ToonMaterial color={color} />
          </mesh>
        </group>
      );
    case 3:
      // Coque no alto, atras.
      return (
        <group>
          {cap}
          <mesh position={[0, 0.3, -0.12]}>
            <sphereGeometry args={[0.11, 12, 10]} />
            <ToonMaterial color={color} />
          </mesh>
        </group>
      );
    default:
      return cap;
  }
}

/**
 * O personagem: chibi procedural de primitivas. Cabeca esferica grande com
 * rosto e cabelo, camisa na cor do agente (e ela quem identifica quem e quem),
 * calca e sapatos, dois bracos curtos sem maos. A aparencia (pele, cabelo,
 * calca) e deterministica por agentId, como a mesa e a cor.
 *
 * Toda animacao roda aqui dentro em useFrame mutando refs -- posicao,
 * waypoints, fase e pose nunca passam por setState. O componente so
 * re-renderiza quando o placement muda (evento novo), e mesmo assim apenas
 * ajusta o alvo: quem anda e o frame.
 */
export function Character({ placement }: CharacterProps) {
  const root = useRef<Group>(null!);
  const squash = useRef<Group>(null!);
  const body = useRef<Group>(null!);
  const head = useRef<Group>(null!);
  const armLeft = useRef<Group>(null!);
  const armRight = useRef<Group>(null!);
  const bubbleAnchor = useRef<Group>(null!);

  // Nasceu na porta, anda para a mesa: o primeiro caminho ja sai pronto.
  // (useRef guarda so o primeiro valor; recomputar nos renders seguintes e
  // barato e descartado.)
  const spawn = { x: DOOR_WORLD.x + placement.spawnOffset.x, z: DOOR_WORLD.z + placement.spawnOffset.z };
  const rig = useRef<Rig>({
    phase: 'spawning',
    clock: 0,
    anim: 0,
    x: spawn.x,
    z: spawn.z,
    waypoints: [...buildPath(spawn, placement.target)],
    targetRot: Math.PI,
    mode: 'idle',
    pose: { y: 0, leanX: 0, swayZ: 0, armL: 0, armR: 0, headTilt: 0 },
  });

  const targetX = placement.target.x;
  const targetZ = placement.target.z;
  const facing = placement.rotationY;

  /**
   * As paradas do caminho atual, fora das dependencias do efeito de proposito.
   *
   * `derivePlacements` monta uma lista nova a cada render, e um render acontece
   * toda vez que **qualquer** agente muda de estado. Se a lista entrasse nas
   * dependencias, quem ja esta sentado no lounge replanejaria a rota a cada
   * evento da execucao -- e sairia andando de volta para o corredor. Ela so
   * muda junto com o alvo, que e quem manda replanejar.
   */
  const via = useRef(placement.via);
  via.current = placement.via;

  // Alvo novo (sentou, levantou, foi descansar): replaneja o caminho a partir
  // de onde o boneco esta agora.
  useEffect(() => {
    const r = rig.current;
    r.waypoints = [...buildRoute({ x: r.x, z: r.z }, via.current, { x: targetX, z: targetZ })];
    r.targetRot = facing;
  }, [targetX, targetZ, facing]);

  useFrame((_, deltaRaw) => {
    const delta = Math.min(deltaRaw, 0.05);
    const r = rig.current;
    r.anim += delta;

    if (r.phase !== 'active') {
      r.clock += delta * 1000;
      if (r.phase === 'spawning' && r.clock >= SPAWN_MS) {
        r.phase = 'active';
        r.clock = 0;
      }
    }

    // Movimento ao longo dos waypoints, com rotacao na direcao do passo.
    if (r.phase === 'active' && r.waypoints.length > 0) {
      r.mode = 'walk';
      const next = r.waypoints[0];
      if (next !== undefined) {
        const dx = next.x - r.x;
        const dz = next.z - r.z;
        const dist = Math.hypot(dx, dz);
        const step = WALK_SPEED * placement.walkPace * delta;
        if (dist <= step) {
          r.x = next.x;
          r.z = next.z;
          r.waypoints = r.waypoints.slice(1);
          if (r.waypoints.length === 0) r.targetRot = facing;
        } else {
          r.x += (dx / dist) * step;
          r.z += (dz / dist) * step;
          r.targetRot = Math.atan2(dx, dz);
        }
      }
    } else if (r.phase === 'active') {
      r.mode = placement.anim;
    } else {
      r.mode = 'idle';
    }

    // Pose amortecida: trocar de modo nunca da um salto.
    const target = poseFor(r.mode, r.anim);
    const p = r.pose;
    p.y = damp(p.y, target.y, 12, delta);
    p.leanX = damp(p.leanX, target.leanX, 12, delta);
    p.swayZ = damp(p.swayZ, target.swayZ, 12, delta);
    p.armL = damp(p.armL, target.armL, 12, delta);
    p.armR = damp(p.armR, target.armR, 12, delta);
    p.headTilt = damp(p.headTilt, target.headTilt, 12, delta);

    root.current.position.set(r.x, 0, r.z);
    root.current.rotation.y = dampAngle(root.current.rotation.y, r.targetRot, 10, delta);

    // A nuvem de pensamento fica sempre a direita da cabeca na tela e de
    // frente para a camera, nao importa para onde o personagem olhe.
    const anchor = billboardAnchor(root.current.rotation.y, BUBBLE_RADIUS, BUBBLE_HEIGHT);
    bubbleAnchor.current.rotation.y = anchor.rotationY;
    bubbleAnchor.current.position.set(anchor.x, anchor.y, anchor.z);

    // Squash and stretch sincronizado com a fumaca da chegada.
    const s = r.phase === 'spawning' ? squashScale(Math.min(r.clock / SPAWN_MS, 1)) : 1;
    const sxz = 1 + (1 - s) * 0.45;
    squash.current.scale.set(sxz, s, sxz);

    body.current.position.y = p.y;
    body.current.rotation.x = p.leanX;
    body.current.rotation.z = p.swayZ;
    armLeft.current.rotation.x = p.armL;
    armRight.current.rotation.x = p.armR;
    head.current.rotation.z = p.headTilt;
  });

  return (
    <group ref={root} position={[rig.current.x, 0, rig.current.z]}>
      {/* Marcador de chao: anel discreto na cor do agente, para identificar
          quem e quem a distancia. Overlay: nao imprime na sombra de contato.
          Fica acima do tapete do lounge (topo em 0,05), senao some justamente
          de quem foi descansar -- e e ele que diz quem e quem. */}
      <mesh
        ref={(mesh) => {
          if (mesh !== null) mesh.layers.set(OVERLAY_LAYER);
        }}
        position={[0, 0.06, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[0.3, 0.42, 32]} />
        <meshBasicMaterial color={placement.color} transparent opacity={0.5} depthWrite={false} />
      </mesh>

      <group ref={squash} scale={[1.36, 0.2, 1.36]}>
        <group ref={body}>
          {/* Calca e sapatos. */}
          <mesh position={[0, 0.3, 0]}>
            <capsuleGeometry args={[0.21, 0.16, 6, 14]} />
            <ToonMaterial color={placement.appearance.pants} />
          </mesh>
          {[-0.11, 0.11].map((x) => (
            <mesh key={x} position={[x, 0.04, 0.05]}>
              <boxGeometry args={[0.14, 0.08, 0.2]} />
              <ToonMaterial color={DARK} />
            </mesh>
          ))}

          {/* Camisa na cor do agente, cobrindo a cintura da calca. */}
          <mesh position={[0, 0.5, 0]}>
            <capsuleGeometry args={[0.23, 0.18, 6, 14]} />
            <ToonMaterial color={placement.color} />
          </mesh>

          {/* Cabeca esferica grande (~45% da altura), sem pescoco: afunda na
              camisa. Pele por tom, cabelo por estilo, rosto virado para +z. */}
          <group ref={head} position={[0, 0.86, 0]}>
            <mesh>
              <sphereGeometry args={[0.3, 24, 18]} />
              <ToonMaterial color={placement.appearance.skin} />
            </mesh>
            <Hair style={placement.appearance.hairStyle} color={placement.appearance.hair} />
            {[-0.1, 0.1].map((x) => (
              <mesh key={x} position={[x, 0.02, 0.265]}>
                <sphereGeometry args={[0.035, 10, 8]} />
                <meshBasicMaterial color={DARK} />
              </mesh>
            ))}
          </group>

          {/* Bracos em capsulas curtas, pendurados no ombro; sem maos. */}
          <group ref={armLeft} position={[-0.3, 0.62, 0]}>
            <mesh position={[0, -0.14, 0]}>
              <capsuleGeometry args={[0.075, 0.22, 4, 10]} />
              <ToonMaterial color={placement.color} />
            </mesh>
          </group>
          <group ref={armRight} position={[0.3, 0.62, 0]}>
            <mesh position={[0, -0.14, 0]}>
              <capsuleGeometry args={[0.075, 0.22, 4, 10]} />
              <ToonMaterial color={placement.color} />
            </mesh>
          </group>
        </group>
      </group>

      {/* A nuvem de pensamento: aparece com codigo ficticio rolando enquanto o
          agente esta `thinking`. A ancora e girada para a camera no useFrame. */}
      <group ref={bubbleAnchor} position={[INITIAL_ANCHOR.x, INITIAL_ANCHOR.y, INITIAL_ANCHOR.z]}>
        <ThoughtBubble agentId={placement.agentId} visible={placement.anim === 'think'} />
      </group>

      {/* A fumaca da chegada, uma vez so ao montar. Nao existe fumaca de saida:
          ninguem sai do escritorio -- quem termina vai para o lounge. */}
      <SpawnPuff />
    </group>
  );
}
