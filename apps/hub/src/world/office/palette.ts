/**
 * Paleta da direcao visual: low-poly arredondado, cores vivas, humor de jogo
 * casual isometrico. Tudo que a cena pinta sai daqui.
 */
export const FLOOR_A = '#F4EFE6';
export const FLOOR_B = '#EDE6DA';
// Paredes do diorama: verde-azulado, com a oeste mais clara para dar profundidade.
export const WALL_NORTH = '#2F6B6B';
export const WALL_WEST = '#3B7F7C';
export const WALL = '#E3D9C9';
export const FURNITURE = '#C98A52';
export const FURNITURE_DARK = '#A96F3D';
export const SCREEN = '#3B3F4A';
export const PLANT = '#63B77C';
export const PUFF = '#FFFFFF';
export const BACKGROUND = '#E6DFD2';

/**
 * Cor de cada agente. O indice vem do hash do agentId: a mesma execucao
 * sempre pinta os mesmos personagens iguais, em qualquer maquina.
 */
export const AGENT_COLORS = [
  '#FF6B5A', // coral
  '#FFC93C', // amarelo
  '#2EC4B6', // turquesa
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
