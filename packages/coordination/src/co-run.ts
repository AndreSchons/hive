import type { Subtask } from '@hive/protocol';

/**
 * Quem pode correr junto com quem.
 *
 * O grafo de dependencia diz o que **esta liberado**; ele nao diz o que e
 * seguro rodar ao mesmo tempo. Duas subtasks sem dependencia entre si podem
 * mexer na mesma pasta, e ai o conflito de merge nao e azar: e consequencia
 * previsivel, e ja e o preditor que o harness do gerente mede
 * (`tools/planner-lab/checks.ts`).
 *
 * Entao a regra e uma so: **so correm juntas subtasks cujas areas nao se
 * encostam**. Segurar aqui custa esperar; descobrir depois custa um agente
 * inteiro desfazendo colisao, com a pessoa parada esperando a resposta.
 */

/** Segmentos de um caminho, sem `./`, sem barra sobrando, sem `.` no meio. */
function segments(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
}

/**
 * Um caminho cobre o outro quando um e prefixo do outro **em segmentos**.
 * Comparar texto cru diria que `src/api` cobre `src/apiv2`, que e falso, e
 * espalharia serializacao sobre pastas que nunca se encostam.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const left = segments(a);
  const right = segments(b);
  const shared = Math.min(left.length, right.length);
  // Caminho vazio (a raiz) cobre tudo, e e o que faz `allowedPaths: []` cair
  // no caso conservador em vez de virar "nao encosta em ninguem".
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Areas declaradas vazias querem dizer "sem restricao" -- o agente pode mexer
 * em qualquer lugar. Isso encosta em todo mundo por definicao, entao subtask
 * sem `allowedPaths` nunca corre acompanhada. E deliberado: e o que faz o plano
 * que declara suas areas ganhar paralelismo, e o que nao declara continuar na
 * fila, em vez de o sistema apostar no escuro.
 */
export function areasCollide(a: Subtask, b: Subtask): boolean {
  if (a.allowedPaths.length === 0 || b.allowedPaths.length === 0) return true;
  return a.allowedPaths.some((left) => b.allowedPaths.some((right) => pathsOverlap(left, right)));
}

export interface CoRunChoice {
  /** O que pode comecar agora, na ordem em que foi escolhido. */
  readonly start: readonly Subtask[];
  /**
   * Liberadas pelo grafo que ficaram para depois porque encostam em quem ja
   * esta no ar. Nao e erro -- e a medida de quanto o plano deixou de paralelizar.
   */
  readonly held: readonly Subtask[];
}

/**
 * Escolhe o que entra nos lugares livres. Ordem do plano e criterio de
 * desempate: o gerente ja pensou numa ordem, e reordenar por conta propria
 * tornaria a execucao dificil de explicar para quem esta olhando a tela.
 */
export function chooseCoRunnable(
  ready: readonly Subtask[],
  running: readonly Subtask[],
  maxParallel: number,
): CoRunChoice {
  const start: Subtask[] = [];
  const held: Subtask[] = [];
  const busy = [...running];

  const limit = Math.max(1, maxParallel);
  for (const candidate of ready) {
    // Sem lugar livre nao ha o que decidir, e esperar a vez nao e sinal de nada
    // -- so o que ficou de fora **tendo lugar** conta como paralelismo perdido.
    if (busy.length >= limit) break;
    if (busy.some((other) => areasCollide(candidate, other))) {
      held.push(candidate);
      continue;
    }
    start.push(candidate);
    busy.push(candidate);
  }

  return { start, held };
}
