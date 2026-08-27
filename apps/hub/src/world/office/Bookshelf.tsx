import { useLayoutEffect, useRef } from 'react';
import { Color, InstancedMesh, Object3D } from 'three';
import { BOOKSHELVES } from './layout';
import {
  CREAM,
  MUSTARD,
  TERRACOTTA,
  UPHOLSTERY_BLUE,
  UPHOLSTERY_GREEN,
  WOOD,
  WOOD_DARK,
} from './palette';
import { ToonMaterial } from './toon';

const SHELF_W = 1.8;
const SHELF_H = 2.4;
const SHELF_D = 0.42;
/** Base de cada vao onde os livros ficam em pe. */
const ROW_BASES = [0.1, 0.77, 1.43, 2.03] as const;
const ROW_MAX_HEIGHT = [0.5, 0.5, 0.45, 0.26] as const;

const BOOK_TONES = [TERRACOTTA, MUSTARD, CREAM, UPHOLSTERY_GREEN, UPHOLSTERY_BLUE, WOOD_DARK] as const;

/** PRNG deterministico: a mesma estante nasce com os mesmos livros sempre. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BookItem {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly tone: number;
}

/** Livros em coordenadas locais da estante (frente virada para +z). */
function buildBooks(seed: number): readonly BookItem[] {
  const rand = mulberry32(seed);
  const books: BookItem[] = [];

  ROW_BASES.forEach((baseY, row) => {
    // Vao reservado para os objetos: fileira 1 a direita, 2 a esquerda, topo a direita.
    const gap: readonly [number, number] =
      row === 1 ? [0.3, 0.75] : row === 2 ? [-0.75, -0.3] : row === 3 ? [0.15, 0.8] : [2, 2];

    let cursor = -0.78;
    while (cursor < 0.78) {
      const width = 0.05 + rand() * 0.07;
      if (cursor + width > gap[0] && cursor < gap[1]) {
        cursor = gap[1];
        continue;
      }
      const maxHeight = ROW_MAX_HEIGHT[row] ?? 0.4;
      const height = 0.18 + rand() * (maxHeight - 0.14);
      books.push({
        position: [cursor + width / 2, baseY + height / 2, -0.06],
        scale: [width, height, 0.24],
        tone: Math.floor(rand() * BOOK_TONES.length),
      });
      cursor += width + 0.015 + (rand() < 0.12 ? 0.06 : 0);
    }
  });

  return books;
}

function Books({ items }: { readonly items: readonly BookItem[] }) {
  const ref = useRef<InstancedMesh>(null!);

  useLayoutEffect(() => {
    const mesh = ref.current;
    const dummy = new Object3D();
    const color = new Color();
    items.forEach((book, index) => {
      dummy.position.set(book.position[0], book.position[1], book.position[2]);
      dummy.scale.set(book.scale[0], book.scale[1], book.scale[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, color.set(BOOK_TONES[book.tone] ?? BOOK_TONES[0]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [items]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <ToonMaterial color="#FFFFFF" />
    </instancedMesh>
  );
}

function BookshelfUnit({
  center,
  rotationY,
  seed,
}: {
  readonly center: { readonly x: number; readonly z: number };
  readonly rotationY: number;
  readonly seed: number;
}) {
  const books = buildBooks(seed);

  return (
    <group position={[center.x, 0, center.z]} rotation={[0, rotationY, 0]}>
      {/* Corpo da estante */}
      <mesh position={[0, SHELF_H / 2, -SHELF_D / 2 + 0.025]}>
        <boxGeometry args={[SHELF_W, SHELF_H, 0.05]} />
        <ToonMaterial color={WOOD_DARK} />
      </mesh>
      <mesh position={[-(SHELF_W / 2 - 0.03), SHELF_H / 2, 0]}>
        <boxGeometry args={[0.06, SHELF_H, SHELF_D]} />
        <ToonMaterial color={WOOD} />
      </mesh>
      <mesh position={[SHELF_W / 2 - 0.03, SHELF_H / 2, 0]}>
        <boxGeometry args={[0.06, SHELF_H, SHELF_D]} />
        <ToonMaterial color={WOOD} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[SHELF_W, 0.1, SHELF_D]} />
        <ToonMaterial color={WOOD} />
      </mesh>
      <mesh position={[0, SHELF_H - 0.03, 0]}>
        <boxGeometry args={[SHELF_W, 0.06, SHELF_D]} />
        <ToonMaterial color={WOOD} />
      </mesh>
      {[0.72, 1.38, 1.98].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[SHELF_W - 0.12, 0.05, SHELF_D - 0.06]} />
          <ToonMaterial color={WOOD} />
        </mesh>
      ))}

      <Books items={books} />

      {/* Objetos nas prateleiras, nos vaos deixados pelos livros. */}
      <mesh position={[0.52, 0.88, -0.04]}>
        <cylinderGeometry args={[0.07, 0.1, 0.22, 12]} />
        <ToonMaterial color={MUSTARD} />
      </mesh>
      <mesh position={[-0.52, 1.52, -0.04]}>
        <boxGeometry args={[0.22, 0.18, 0.2]} />
        <ToonMaterial color={TERRACOTTA} />
      </mesh>
      <mesh position={[0.45, 2.05, -0.04]}>
        <boxGeometry args={[0.26, 0.04, 0.2]} />
        <ToonMaterial color={CREAM} />
      </mesh>
      <mesh position={[0.45, 2.09, -0.04]}>
        <boxGeometry args={[0.22, 0.04, 0.18]} />
        <ToonMaterial color={MUSTARD} />
      </mesh>
    </group>
  );
}

/** Uma estante alta de madeira em cada parede, cheia de livros instanciados. */
export function Bookshelves() {
  return (
    <group>
      {BOOKSHELVES.map((shelf, index) => (
        <BookshelfUnit
          key={`${shelf.center.x},${shelf.center.z}`}
          center={shelf.center}
          rotationY={shelf.rotationY}
          seed={11 + index * 17}
        />
      ))}
    </group>
  );
}
