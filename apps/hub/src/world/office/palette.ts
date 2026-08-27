/**
 * Paleta da direcao visual: ilustracao de escritorio em tres dimensoes.
 * Paredes verde-azuladas, madeira quente, acentos chapados. Tudo que a cena
 * pinta sai daqui.
 */

// Paredes do diorama: a oeste um tom mais claro para dar profundidade.
export const WALL_NORTH = '#2F6B6B';
export const WALL_WEST = '#3B7F7C';

// Madeira dos moveis e o rodape escuro.
export const WOOD = '#B5743C';
export const WOOD_DARK = '#8B5A2B';

// Piso de madeira clara em duas faixas de tom (tabuas), tapete do lounge.
export const FLOOR_A = '#D9A968';
export const FLOOR_B = '#CF9E5F';
export const RUG = '#9E4A42';
export const RUG_DARK = '#8A3F38';
export const LAMP_DARK = '#3E3633';

// Acentos chapados.
export const TERRACOTTA = '#C0453B';
export const MUSTARD = '#E8B04B';
export const CREAM = '#F2E6D0';

// Estofados do lounge.
export const UPHOLSTERY_GREEN = '#3F6B4A';
export const UPHOLSTERY_BLUE = '#3D5A8A';

export const SCREEN = '#3B3F4A';
export const PLANT = '#58A45C';
export const PUFF = '#FFFFFF';
export const BACKGROUND = CREAM;

// Gente: pele, cabelo e roupa dos personagens. A camisa fica com a cor do
// agente (e ela quem identifica quem e quem); o resto varia por pessoa.
export const SKIN_TONES = ['#F2C89F', '#D9A06B', '#A06B42'] as const;
export const HAIR_TONES = ['#241F1C', '#4A3220', '#8A4A2B', '#D9A45B', '#8A8A8A'] as const;
export const PANTS_TONES = ['#323E52', '#4A3A2C'] as const;
export const DARK = '#241F1C';

/**
 * Cor de cada agente. O indice vem do hash do agentId: a mesma execucao
 * sempre pinta os mesmos personagens iguais, em qualquer maquina.
 *
 * Todas contrastam com o verde-azulado das paredes de proposito: identificar
 * quem e quem a distancia e funcao do produto.
 */
export const AGENT_COLORS = [
  '#FF6B5A', // coral
  '#FFC93C', // amarelo
  '#F2609E', // rosa
  '#7C6BF5', // roxo
  '#4ADE80', // verde
  '#4C9AFF', // azul
] as const;

/** FNV-1a 32 bits: hash deterministico, sem depender de seed nem de runtime. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function agentColor(agentId: string): string {
  const index = hashString(agentId) % AGENT_COLORS.length;
  return AGENT_COLORS[index] ?? AGENT_COLORS[0];
}
