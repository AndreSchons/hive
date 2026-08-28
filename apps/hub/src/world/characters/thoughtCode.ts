import { hashString } from '../office/palette';

/**
 * As linhas de codigo ficticio que passam na nuvem de pensamento. Nao sao um
 * programa: sao desenho animado, mas com a cara do que o escritorio faz.
 *
 * Curtas de proposito. Na tela o rolo tem a largura de uma cabeca, e uma linha
 * de trinta caracteres ali vira risco cinza -- ate umas onze ainda se le que e
 * codigo. O recuo irregular e o que da o ar de programa de verdade.
 */
const CODE_POOL: readonly string[] = [
  'cafe()',
  'if (bug) {',
  '  fix(tudo)',
  '}',
  'pnpm test',
  'merge ok',
  'contrato+',
  'login()',
  'deploy!',
  'while (1)',
  'task.done',
  'squash -1',
];

/**
 * A sequencia de linhas de cada agente: a mesma piscina, girada num ponto
 * deterministico por agentId -- cada personagem pensa em uma coisa diferente,
 * e o replay mostra sempre os mesmos pensamentos.
 */
export function codePoolFor(agentId: string): readonly string[] {
  const start = hashString(`${agentId}:pensamento`) % CODE_POOL.length;
  return [...CODE_POOL.slice(start), ...CODE_POOL.slice(0, start)];
}

export const CODE_POOL_SIZE = CODE_POOL.length;
