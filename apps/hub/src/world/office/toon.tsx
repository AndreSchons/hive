import { DataTexture, NearestFilter, RedFormat, type Side } from 'three';

/**
 * O gradientMap de dois tons compartilhado por todo MeshToonMaterial da cena.
 * E ele quem produz o corte seco entre luz e sombra da ilustracao: nada de
 * gradiente suave.
 */
const data = new Uint8Array([140, 255]);
export const toonGradient = new DataTexture(data, 2, 1, RedFormat);
toonGradient.minFilter = NearestFilter;
toonGradient.magFilter = NearestFilter;
toonGradient.generateMipmaps = false;
toonGradient.needsUpdate = true;

/**
 * Overlays planos (vidro, feixes de luz, marcadores de chao, fumaca) vivem na
 * camada 1: a camera principal os enxerga, mas o ContactShadows -- que
 * renderiza a cena de baixo para cima com a camada padrao -- nao os captura.
 * Sem isso eles imprimiriam manchas na sombra de contato.
 */
export const OVERLAY_LAYER = 1;

interface ToonMaterialProps {
  readonly color: string;
  readonly side?: Side;
}

/** O material da casa: toon em dois tons, sem PBR, sem metalness/roughness. */
export function ToonMaterial({ color, side }: ToonMaterialProps) {
  return (
    <meshToonMaterial
      color={color}
      gradientMap={toonGradient}
      {...(side === undefined ? {} : { side })}
    />
  );
}
