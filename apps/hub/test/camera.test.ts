import { describe, expect, it } from 'vitest';
import { billboardAnchor, CAMERA_AZIMUTH, cameraPosition } from '../src/world/camera';

/** Onde a ancora cai no mundo, ja aplicada a rotacao Y do personagem. */
function toWorld(parentRotationY: number, radius: number, height: number) {
  const a = billboardAnchor(parentRotationY, radius, height);
  const cos = Math.cos(parentRotationY);
  const sin = Math.sin(parentRotationY);
  return {
    x: a.x * cos + a.z * sin,
    y: a.y,
    z: -a.x * sin + a.z * cos,
    rotationY: a.rotationY + parentRotationY,
  };
}

/** Deslocamento horizontal na tela, na projecao ortografica da cena. */
function screenX(point: { x: number; z: number }): number {
  return point.x * Math.cos(CAMERA_AZIMUTH) - point.z * Math.sin(CAMERA_AZIMUTH);
}

const ROTATIONS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.3, 5.7];

describe('billboardAnchor', () => {
  it('poe o adorno no mesmo ponto do mundo para qualquer rotacao do personagem', () => {
    const first = toWorld(0, 0.38, 1.62);
    for (const rotation of ROTATIONS) {
      const world = toWorld(rotation, 0.38, 1.62);
      expect(world.x).toBeCloseTo(first.x, 10);
      expect(world.z).toBeCloseTo(first.z, 10);
      expect(world.y).toBe(1.62);
    }
  });

  it('deixa o adorno de frente para a camera', () => {
    for (const rotation of ROTATIONS) {
      const facing = toWorld(rotation, 0.38, 1.62).rotationY;
      expect(Math.cos(facing)).toBeCloseTo(Math.cos(CAMERA_AZIMUTH), 10);
      expect(Math.sin(facing)).toBeCloseTo(Math.sin(CAMERA_AZIMUTH), 10);
    }
  });

  it('desloca de lado na tela, nao na direcao da camera', () => {
    // O erro que isso tranca: deslocar na direcao da camera nao move nada na
    // tela (projecao ortografica) e a nuvem sai por cima da cabeca.
    for (const rotation of ROTATIONS) {
      expect(screenX(toWorld(rotation, 0.38, 1.62))).toBeCloseTo(0.38, 10);
    }
  });

  it('a camera olha do sudeste, no mesmo azimute da ancora', () => {
    const [x, y, z] = cameraPosition;
    expect(x).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(Math.atan2(x, z)).toBeCloseTo(CAMERA_AZIMUTH, 10);
  });
});
