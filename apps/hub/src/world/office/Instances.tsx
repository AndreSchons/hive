import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { InstancedMesh, Object3D } from 'three';

export interface InstanceItem {
  readonly position: readonly [number, number, number];
  readonly rotationY?: number;
  /** Inclinacao para frente aplicada DEPOIS do rotationY (ordem YXZ): e o
   *  que faz a folha da planta abrir em leque para fora do vaso. */
  readonly rotationX?: number;
  /** Escala por instancia: pecas de tamanhos diferentes com uma geometria so. */
  readonly scale?: readonly [number, number, number];
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
    dummy.rotation.order = 'YXZ';
    items.forEach((item, index) => {
      dummy.position.set(item.position[0], item.position[1], item.position[2]);
      dummy.rotation.set(item.rotationX ?? 0, item.rotationY ?? 0, 0);
      const scale = item.scale ?? [1, 1, 1];
      dummy.scale.set(scale[0], scale[1], scale[2]);
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
