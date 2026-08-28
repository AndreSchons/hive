import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { CanvasTexture, Group, SRGBColorSpace } from 'three';
import { OVERLAY_LAYER, ToonMaterial } from '../office/toon';
import { codePoolFor } from './thoughtCode';

/** Uma linha nova de codigo ficticio a cada SCROLL_MS. */
const SCROLL_MS = 240;
/**
 * Tres linhas, nao cinco. A camera do escritorio inteiro cabe em zoom 40:
 * um mundo vale 40 pixels, entao o rolo tem ~24 pixels de altura na tela.
 * Dividido em cinco linhas isso vira mancha cinza; em tres, ainda se le que
 * e codigo passando.
 */
const VISIBLE_LINES = 3;
/** Proporcao do rolo em unidades de mundo, e o canvas no mesmo formato. */
const ROLL_WIDTH = 0.84;
const ROLL_HEIGHT = 0.6;
const CANVAS_WIDTH = 280;
const CANVAS_HEIGHT = 200;
const LINE_PITCH = CANVAS_HEIGHT / VISIBLE_LINES;
/** Tons legiveis sobre a nuvem branca. */
const LINE_COLORS = ['#22304A', '#2F6B6B', '#9E4A42', '#8B5A2B'] as const;

/**
 * O cacho: uma nuvem de balao de quadrinho, larga o bastante para o rolo de
 * codigo caber dentro da silhueta branca em vez de vazar para o chao.
 */
const CLOUD: readonly (readonly [number, number, number, number])[] = [
  // x, y, z, raio -- o cacho cobre os cantos do rolo (+-0.42 x +-0.30), senao
  // a ultima linha de codigo cai fora do branco e fica escrita no chao.
  [0, 0, 0, 0.35],
  [0.4, 0.03, 0, 0.27],
  [-0.4, 0.03, 0, 0.27],
  [0.2, 0.24, 0, 0.245],
  [-0.2, 0.25, 0, 0.235],
  [0.23, -0.2, 0, 0.27],
  [-0.23, -0.2, 0, 0.27],
];

/**
 * Bolhinhas descendo ate a cabeca, como nos desenhos. A ultima quase encosta
 * no topo do cranio (y 1.16 no personagem), entao a nuvem tem dono.
 */
const TRAIL: readonly (readonly [number, number, number])[] = [
  [-0.52, -0.62, 0.075],
  [-0.3, -0.42, 0.11],
];

interface ThoughtBubbleProps {
  readonly agentId: string;
  /** true enquanto o agente esta `thinking`: entra com pop, some do mesmo jeito. */
  readonly visible: boolean;
}

/**
 * A nuvem de pensamento: bolas brancas em cacho com um rolo de codigo
 * ficticio passando dentro, desenhado num canvas. Quem monta a ancora e a
 * gira para a camera e o Character; aqui dentro so tem desenho. Nada de
 * setState: o relogio do rolo mora em refs e o redraw e textura, nao estado.
 */
export function ThoughtBubble({ agentId, visible }: ThoughtBubbleProps) {
  const inner = useRef<Group>(null!);
  const scale = useRef(0);
  const bob = useRef(0);
  const sinceDraw = useRef(0);
  const lineIndex = useRef(0);

  const lines = useMemo(() => codePoolFor(agentId), [agentId]);

  const { texture, draw } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d');
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;

    const drawLines = (pool: readonly string[], first: number): void => {
      if (ctx === null) return;
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      // Fonte quase da altura da linha: e o que sobra de legivel depois de o
      // rolo encolher para o tamanho de uma cabeca na tela.
      ctx.font = '700 44px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      for (let row = 0; row < VISIBLE_LINES; row += 1) {
        ctx.fillStyle = LINE_COLORS[(first + row) % LINE_COLORS.length] ?? LINE_COLORS[0];
        ctx.fillText(
          pool[(first + row) % pool.length] ?? '',
          10,
          LINE_PITCH * (row + 0.5),
          CANVAS_WIDTH - 20,
        );
      }
      tex.needsUpdate = true;
    };

    return { texture: tex, draw: drawLines };
  }, []);

  useEffect(() => {
    draw(lines, lineIndex.current);
  }, [draw, lines]);

  // O personagem desmonta quando sai de cena; a textura de canvas nao volta
  // sozinha para o pool da GPU.
  useEffect(() => () => texture.dispose(), [texture]);

  useFrame((_, deltaRaw) => {
    const delta = Math.min(deltaRaw, 0.05);

    // Pop de escala na entrada e na saida.
    const target = visible ? 1 : 0;
    scale.current += (target - scale.current) * (1 - Math.exp(-9 * delta));
    const s = scale.current;
    inner.current.visible = s > 0.02;
    if (!inner.current.visible) return;
    inner.current.scale.setScalar(Math.max(s, 0.0001));

    // Balanco suave do cacho.
    bob.current += delta;
    inner.current.position.y = Math.sin(bob.current * 1.8) * 0.025;

    // O rolo de codigo, em ritmo proprio.
    sinceDraw.current += delta * 1000;
    if (sinceDraw.current >= SCROLL_MS) {
      sinceDraw.current = 0;
      lineIndex.current = (lineIndex.current + 1) % lines.length;
      draw(lines, lineIndex.current);
    }
  });

  return (
    <group ref={inner} visible={false}>
      {CLOUD.map(([x, y, z, radius]) => (
        <mesh
          key={`${x},${y}`}
          position={[x, y, z]}
          ref={(mesh) => {
            if (mesh !== null) mesh.layers.set(OVERLAY_LAYER);
          }}
        >
          <sphereGeometry args={[radius, 16, 12]} />
          <ToonMaterial color="#FFFFFF" />
        </mesh>
      ))}
      {TRAIL.map(([x, y, radius]) => (
        <mesh
          key={`${x},${y}`}
          position={[x, y, 0]}
          ref={(mesh) => {
            if (mesh !== null) mesh.layers.set(OVERLAY_LAYER);
          }}
        >
          <sphereGeometry args={[radius, 12, 10]} />
          <ToonMaterial color="#FFFFFF" />
        </mesh>
      ))}

      {/* O rolo de codigo, na frente da nuvem, de frente para a camera. */}
      <mesh
        position={[0, 0.03, 0.38]}
        ref={(mesh) => {
          if (mesh !== null) mesh.layers.set(OVERLAY_LAYER);
        }}
      >
        <planeGeometry args={[ROLL_WIDTH, ROLL_HEIGHT]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}
