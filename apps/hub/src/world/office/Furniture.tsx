import { Instances, type InstanceItem } from './Instances';
import { DESKS, SIDEBOARD, tileToWorld } from './layout';
import { CREAM, SCREEN, UPHOLSTERY_BLUE, UPHOLSTERY_GREEN, WOOD, WOOD_DARK } from './palette';
import { ToonMaterial } from './toon';

const DESK_TOP_Y = 0.45;

// Toda a mobilia e derivada do layout fixo, uma unica vez. Cada tipo de peca
// vira um InstancedMesh: o escritorio inteiro custa ~12 draw calls.
const deskTops: InstanceItem[] = [];
const deskPanels: InstanceItem[] = [];
const chairSeats: InstanceItem[] = [];
const chairBacks: InstanceItem[] = [];
const chairPads: InstanceItem[] = [];
const monitorScreens: InstanceItem[] = [];
const monitorStands: InstanceItem[] = [];
const mugs: InstanceItem[] = [];
const deskBooks: InstanceItem[] = [];

DESKS.forEach((desk, index) => {
  const deskW = tileToWorld(desk.tile);
  const chairW = tileToWorld(desk.chair);
  // Direcao da cadeira para a mesa (eixo unitario, o layout e ortogonal).
  const dir = { x: deskW.x - chairW.x, z: deskW.z - chairW.z };
  const perp = { x: dir.z, z: -dir.x };
  // O eixo largo do tampo no mundo, depois da rotacao da mesa.
  const wide = { x: Math.cos(desk.rotationY), z: -Math.sin(desk.rotationY) };

  deskTops.push({ position: [deskW.x, DESK_TOP_Y, deskW.z], rotationY: desk.rotationY });

  for (const side of [-0.42, 0.42]) {
    deskPanels.push({
      position: [deskW.x + wide.x * side, DESK_TOP_Y / 2, deskW.z + wide.z * side],
      rotationY: desk.rotationY,
    });
  }

  chairSeats.push({ position: [chairW.x, 0.3, chairW.z], rotationY: desk.rotationY });
  chairBacks.push({
    position: [chairW.x - dir.x * 0.19, 0.55, chairW.z - dir.z * 0.19],
    rotationY: desk.rotationY,
  });
  // Almofada da cadeira: alterna verde e azul de mesa para mesa.
  chairPads.push({ position: [chairW.x, 0.36, chairW.z], rotationY: desk.rotationY });

  // Monitor na borda oposta a cadeira, com a tela virada para quem senta.
  monitorStands.push({
    position: [deskW.x + dir.x * 0.18, DESK_TOP_Y + 0.13, deskW.z + dir.z * 0.18],
    rotationY: desk.rotationY,
  });
  monitorScreens.push({
    position: [deskW.x + dir.x * 0.18, DESK_TOP_Y + 0.39, deskW.z + dir.z * 0.18],
    rotationY: desk.rotationY + Math.PI,
  });

  // Objeto pessoal: caneca em metade das mesas, pilha de livros na outra.
  if (index % 2 === 0) {
    mugs.push({
      position: [deskW.x - dir.x * 0.1 + perp.x * 0.32, DESK_TOP_Y + 0.09, deskW.z - dir.z * 0.1 + perp.z * 0.32],
    });
  } else {
    deskBooks.push({
      position: [deskW.x - dir.x * 0.1 + perp.x * 0.3, DESK_TOP_Y + 0.06, deskW.z - dir.z * 0.1 + perp.z * 0.3],
      rotationY: desk.rotationY + 0.3,
    });
  }
});

/** Mesas, cadeiras, monitores e objetos pessoais, mais o aparador da parede oeste. */
export function Furniture() {
  return (
    <group>
      <Instances items={deskTops}>
        <boxGeometry args={[0.95, 0.09, 0.6]} />
        <ToonMaterial color={WOOD} />
      </Instances>
      <Instances items={deskPanels}>
        <boxGeometry args={[0.08, DESK_TOP_Y, 0.55]} />
        <ToonMaterial color={WOOD_DARK} />
      </Instances>

      <Instances items={chairSeats}>
        <boxGeometry args={[0.42, 0.09, 0.42]} />
        <ToonMaterial color={WOOD_DARK} />
      </Instances>
      <Instances items={chairBacks}>
        <boxGeometry args={[0.42, 0.42, 0.08]} />
        <ToonMaterial color={WOOD_DARK} />
      </Instances>
      <Instances items={chairPads.filter((_, index) => index % 2 === 0)}>
        <boxGeometry args={[0.36, 0.05, 0.36]} />
        <ToonMaterial color={UPHOLSTERY_GREEN} />
      </Instances>
      <Instances items={chairPads.filter((_, index) => index % 2 === 1)}>
        <boxGeometry args={[0.36, 0.05, 0.36]} />
        <ToonMaterial color={UPHOLSTERY_BLUE} />
      </Instances>

      <Instances items={monitorStands}>
        <boxGeometry args={[0.09, 0.18, 0.09]} />
        <ToonMaterial color={WOOD_DARK} />
      </Instances>
      <Instances items={monitorScreens}>
        <boxGeometry args={[0.52, 0.34, 0.06]} />
        <ToonMaterial color={SCREEN} />
      </Instances>

      <Instances items={mugs}>
        <cylinderGeometry args={[0.05, 0.05, 0.1, 12]} />
        <ToonMaterial color={CREAM} />
      </Instances>
      <Instances items={deskBooks}>
        <boxGeometry args={[0.24, 0.12, 0.18]} />
        <ToonMaterial color={UPHOLSTERY_BLUE} />
      </Instances>

      {/* Aparador baixo encostado na parede oeste. */}
      <group position={[SIDEBOARD.center.x, 0, SIDEBOARD.center.z]} rotation={[0, SIDEBOARD.rotationY, 0]}>
        <mesh position={[0, 0.32, 0]}>
          <boxGeometry args={[2.2, 0.55, 0.5]} />
          <ToonMaterial color={WOOD} />
        </mesh>
        <mesh position={[0, 0.62, 0]}>
          <boxGeometry args={[2.3, 0.06, 0.56]} />
          <ToonMaterial color={WOOD_DARK} />
        </mesh>
        {[-0.55, 0.55].map((x) => (
          <mesh key={x} position={[x, 0.32, 0.26]}>
            <boxGeometry args={[0.95, 0.4, 0.03]} />
            <ToonMaterial color={WOOD_DARK} />
          </mesh>
        ))}
        {[-0.95, 0.95].map((x) =>
          [-0.18, 0.18].map((z) => (
            <mesh key={`${x},${z}`} position={[x, 0.02, z]}>
              <boxGeometry args={[0.07, 0.1, 0.07]} />
              <ToonMaterial color={WOOD_DARK} />
            </mesh>
          )),
        )}
      </group>
    </group>
  );
}
