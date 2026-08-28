/**
 * O enquadramento da cena: camera ortografica em angulo fixo, e a conta de
 * pendurar um adorno que deve aparecer sempre no mesmo lugar da tela.
 *
 * Modulo puro de proposito -- sem three, sem React. Quem desenha importa daqui
 * em vez de repetir o angulo: o azimute aparece na posicao da camera e na
 * ancora da nuvem de pensamento, e os dois tem que ser o mesmo numero ou o
 * adorno sai do lugar sem ninguem notar.
 */

/** ~28 graus de elevacao, 45 de azimute: o diorama visto do sudeste. */
export const CAMERA_DISTANCE = 30;
export const CAMERA_ELEVATION = (28 * Math.PI) / 180;
export const CAMERA_AZIMUTH = Math.PI / 4;

export const cameraPosition: readonly [number, number, number] = [
  Math.cos(CAMERA_ELEVATION) * Math.sin(CAMERA_AZIMUTH) * CAMERA_DISTANCE,
  Math.sin(CAMERA_ELEVATION) * CAMERA_DISTANCE,
  Math.cos(CAMERA_ELEVATION) * Math.cos(CAMERA_AZIMUTH) * CAMERA_DISTANCE,
];

/** Pose local de uma ancora dentro de um pai girado em `parentRotationY`. */
export interface BillboardAnchor {
  readonly rotationY: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Onde pendurar um adorno preso a alguem que gira -- a nuvem de pensamento em
 * cima do personagem. Desfaz a rotacao do pai (o adorno fica de frente para a
 * camera) e joga o deslocamento no **eixo horizontal da camera**, entao ele
 * sai sempre a direita da cabeca na tela, olhando o personagem para onde for.
 *
 * Os dois angulos sao o mesmo valor, e nao por acaso: o eixo horizontal da
 * camera no mundo esta em `CAMERA_AZIMUTH`, e girar a ancora para a camera
 * tambem leva o eixo local x para la. Deslocar na direcao da camera em vez
 * disso nao move nada na tela -- projecao ortografica -- e a nuvem cobre a
 * cabeca.
 */
export function billboardAnchor(
  parentRotationY: number,
  radius: number,
  height: number,
): BillboardAnchor {
  const angle = CAMERA_AZIMUTH - parentRotationY;
  return {
    rotationY: angle,
    x: Math.cos(angle) * radius,
    y: height,
    z: -Math.sin(angle) * radius,
  };
}
