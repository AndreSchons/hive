import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { InstancedMesh, Object3D } from 'three';

export interface InstanceItem {
  readonly position: readonly [number, number, number];
  readonly rotationY?: number;
}

interface InstancesProps {
  readonly items: readonly InstanceItem[];
  /** Geometria + material, iguais para todas as instancias. */
  readonly children: ReactNode;
}

/**
 * Tudo que se repete na cena vira um InstancedMesh: uma draw call por tipo de
 * peca, nao por peca. Os itens sao dados fixos do layout, entao as matrizes
 * sobem para a GPU uma unica vez.
 */
export function Instances({ items, children }: InstancesProps) {
  const ref = useRef<InstancedMesh>(null!);

  useLayoutEffect(() => {
    const mesh = ref.current;
    const dummy = new Object3D();
    items.forEach((item, index) => {
      dummy.position.set(item.position[0], item.position[1], item.position[2]);
      dummy.rotation.set(0, item.rotationY ?? 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false}>
      {children}
    </instancedMesh>
  );
}
