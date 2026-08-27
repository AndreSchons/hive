import { Instances, type InstanceItem } from './Instances';
import { DESKS, PLANT_SPOTS, tileToWorld } from './layout';
import { FURNITURE, FURNITURE_DARK, PLANT, SCREEN } from './palette';

const DESK_TOP_Y = 0.45;

// Toda a mobilia e derivada do layout fixo, uma unica vez. Cada tipo de peca
// vira um InstancedMesh: o escritorio inteiro custa ~10 draw calls.
const deskTops: InstanceItem[] = [];
const deskPanels: InstanceItem[] = [];
const chairSeats: InstanceItem[] = [];
const chairBacks: InstanceItem[] = [];
const monitorScreens: InstanceItem[] = [];
const monitorStands: InstanceItem[] = [];
const mugs: InstanceItem[] = [];

for (const desk of DESKS) {
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

  // Monitor na borda oposta a cadeira, com a tela virada para quem senta.
  monitorStands.push({
    position: [deskW.x + dir.x * 0.18, DESK_TOP_Y + 0.13, deskW.z + dir.z * 0.18],
    rotationY: desk.rotationY,
  });
  monitorScreens.push({
    position: [deskW.x + dir.x * 0.18, DESK_TOP_Y + 0.39, deskW.z + dir.z * 0.18],
    rotationY: desk.rotationY + Math.PI,
  });

  mugs.push({
    position: [deskW.x - dir.x * 0.1 + perp.x * 0.32, DESK_TOP_Y + 0.09, deskW.z - dir.z * 0.1 + perp.z * 0.32],
  });
}

const plantPots: InstanceItem[] = [];
const plantBushes: InstanceItem[] = [];
for (const spot of PLANT_SPOTS) {
  const { x, z } = tileToWorld(spot);
  plantPots.push({ position: [x, 0.17, z] });
  plantBushes.push({ position: [x, 0.6, z] });
  plantBushes.push({ position: [x + 0.12, 0.86, z - 0.08] });
}

/** Mesas, cadeiras, monitores, canecas e plantas do escritorio. */
export function Furniture() {
  return (
    <group>
      <Instances items={deskTops}>
        <boxGeometry args={[0.95, 0.09, 0.6]} />
        <meshLambertMaterial color={FURNITURE} />
      </Instances>
      <Instances items={deskPanels}>
        <boxGeometry args={[0.08, DESK_TOP_Y, 0.55]} />
        <meshLambertMaterial color={FURNITURE_DARK} />
      </Instances>

      <Instances items={chairSeats}>
        <boxGeometry args={[0.42, 0.09, 0.42]} />
        <meshLambertMaterial color={FURNITURE_DARK} />
      </Instances>
      <Instances items={chairBacks}>
        <boxGeometry args={[0.42, 0.42, 0.08]} />
        <meshLambertMaterial color={FURNITURE_DARK} />
      </Instances>

      <Instances items={monitorStands}>
        <boxGeometry args={[0.09, 0.18, 0.09]} />
        <meshLambertMaterial color={FURNITURE_DARK} />
      </Instances>
      <Instances items={monitorScreens}>
        <boxGeometry args={[0.52, 0.34, 0.06]} />
        <meshLambertMaterial color={SCREEN} />
      </Instances>

      <Instances items={mugs}>
        <cylinderGeometry args={[0.05, 0.05, 0.1, 12]} />
        <meshLambertMaterial color="#EFE7DA" />
      </Instances>

      <Instances items={plantPots}>
        <cylinderGeometry args={[0.2, 0.26, 0.34, 12]} />
        <meshLambertMaterial color={FURNITURE_DARK} />
      </Instances>
      <Instances items={plantBushes}>
        <sphereGeometry args={[0.34, 18, 14]} />
        <meshLambertMaterial color={PLANT} />
      </Instances>
    </group>
  );
}
