import { z } from 'zod';
import { agentId } from '../ids';
import { contractSchema, planSchema } from '../plan';

export const planEventPayloads = {
  /** Carrega o plano inteiro: o mundo 3D reconstroi o quadro sem consultar nada. */
  'plan.created': z.object({
    plan: planSchema,
    createdBy: agentId,
  }),
  'plan.revised': z.object({
    plan: planSchema,
    revisedBy: agentId,
    reason: z.string().min(1),
  }),
  'contract.published': z.object({
    contract: contractSchema,
    publishedBy: agentId,
    /** Subtasks que estavam esperando este contrato para poder comecar. */
    unblocks: z.array(z.string()).default([]),
  }),
  /**
   * O que rodar em paralelo comprou, em milissegundos. Sai uma vez por plano
   * executado, inclusive quando a execucao parou no meio -- medida so serve se
   * existir tambem no dia em que deu errado.
   */
  'plan.measured': z.object({
    /** Relogio de parede da execucao do plano: do primeiro agente ao ultimo merge. */
    wallMs: z.number().int().nonnegative(),
    /**
     * Soma do tempo que cada subtask ocupou de ponta a ponta -- copia, agente,
     * portao e integracao. E o que este mesmo plano teria custado um de cada
     * vez, e por isso a diferenca para `wallMs` e a economia de verdade.
     */
    sequentialMs: z.number().int().nonnegative(),
    /** Quanto do tempo foi juntar trabalho: o merge de cada subtask. */
    mergeMs: z.number().int().nonnegative(),
    /**
     * A parte do merge que foi desfazer colisao. Separado de proposito: merge
     * limpo a fila sequencial tambem paga, mas conflito e o preco que sai de
     * dois agentes partirem do mesmo ponto sem terem combinado o suficiente.
     */
    conflictMs: z.number().int().nonnegative().default(0),
    /** O que desfazer colisao custou de modelo. Zero quando ninguem colidiu. */
    conflictCostUsd: z.number().nonnegative().default(0),
    conflicts: z.number().int().nonnegative().default(0),
    /** Quantas subtasks estiveram no ar ao mesmo tempo, no pico. 1 = foi fila. */
    peakParallel: z.number().int().positive().default(1),
    /**
     * Subtasks liberadas pelo grafo que mesmo assim esperaram, porque mexiam
     * na mesma area de outra ja rodando. E o preditor direto de conflito, e
     * segurar aqui custa menos que desfazer depois.
     */
    heldForOverlap: z.number().int().nonnegative().default(0),
  }),
} as const;

export type ParallelismMeasure = z.infer<(typeof planEventPayloads)['plan.measured']>;

/**
 * O veredito da medida, num lugar so.
 *
 * O criterio nao e "rodou junto", e **sobrou tempo**: juntar dois trabalhos que
 * sairam do mesmo ponto de partida custa merge, e colisao custa um agente
 * inteiro para desfazer. Quando esse custo passa do que a sobreposicao
 * economizou, quem falhou foi a etapa de contrato -- os dois especialistas nao
 * estavam de acordo sobre o que cada um ia mexer -- e nao a ideia de paralelizar.
 */
export function parallelismGain(measure: ParallelismMeasure): {
  /** Quanto a sobreposicao economizou. Negativo nao existe: fila nao economiza. */
  readonly savedMs: number;
  /** Falso quando juntar custou mais do que correr junto rendeu. */
  readonly worthIt: boolean;
} {
  const savedMs = Math.max(0, measure.sequentialMs - measure.wallMs);
  return { savedMs, worthIt: savedMs > measure.mergeMs };
}
