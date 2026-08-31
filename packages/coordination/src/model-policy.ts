import { MODEL_TIERS, type GateKind, type ModelTier, type RoleDefinition } from '@hive/protocol';

export interface ModelRecommendation {
  readonly tier: ModelTier;
  /**
   * Por que este degrau, numa frase curta e sem jargao. Aparece ao lado do
   * passo na hora de aprovar o plano, entao quem le nao le codigo.
   */
  readonly reason: string;
}

/**
 * O passo e o que o resto do plano diz sobre ele.
 *
 * A forma e estrutural de proposito: a recomendacao acontece **enquanto** a
 * subtask esta sendo montada, antes de ela existir por inteiro.
 */
export interface ModelRequest {
  readonly subtask: {
    readonly allowedPaths: readonly string[];
    readonly inputContracts: readonly string[];
    readonly gate: { readonly kind: GateKind };
  };
  /** Quantos outros passos dependem deste. */
  readonly dependents: number;
}

/**
 * Que modelo cada passo pede.
 *
 * A recomendacao sai de **sinais que o plano ja declara** -- quantas areas o
 * passo toca, se ele tem contrato de entrada, quantos passos dependem dele --
 * e nunca de opiniao do modelo sobre o proprio trabalho. E a mesma regra que
 * vale para orcamento, pela mesma razao: quem paga a conta e quem decide.
 *
 * Quem decide de verdade e a pessoa: isto aqui e a sugestao que ela ve e pode
 * mover inteira para mais barato ou mais caprichado antes de comecar.
 */
export interface ModelPolicy {
  recommend(request: ModelRequest): ModelRecommendation;
}

export class DefaultModelPolicy implements ModelPolicy {
  /**
   * A ordem e o que decide, e ela vai do risco maior para o menor. Um passo
   * que e base de outros erra caro: o erro dele viaja para todos os que vem
   * depois, e refazer sai mais caro que ter feito bem da primeira vez.
   */
  recommend({ subtask, dependents }: ModelRequest): ModelRecommendation {
    if (dependents >= 2) {
      return {
        tier: 'caprichado',
        reason: `outros ${dependents} passos dependem deste`,
      };
    }
    if (subtask.inputContracts.length > 0) {
      return { tier: 'padrao', reason: 'precisa seguir o que foi combinado com outro passo' };
    }
    if (subtask.gate.kind === 'test' || subtask.gate.kind === 'build') {
      return {
        tier: 'padrao',
        reason:
          subtask.gate.kind === 'test'
            ? 'os testes do projeto precisam continuar passando'
            : 'o projeto precisa continuar montando',
      };
    }
    if (subtask.allowedPaths.length > 1) {
      return {
        tier: 'padrao',
        reason: `mexe em ${subtask.allowedPaths.length} areas do projeto`,
      };
    }
    if (subtask.allowedPaths.length === 1) {
      return { tier: 'economico', reason: 'mexe numa area so' };
    }
    // Sem area declarada nao da para dizer que e pequeno.
    return { tier: 'padrao', reason: 'tamanho comum' };
  }
}

/** Para onde a postura escolhida pela pessoa move a escada. */
export type Posture = 'economico' | 'recomendado' | 'caprichado';

const SHIFT: Record<Posture, number> = { economico: -1, recomendado: 0, caprichado: 1 };

/** O degrau depois da postura, sem sair das pontas da escada. */
export function shiftTier(tier: ModelTier, posture: Posture): ModelTier {
  const index = MODEL_TIERS.indexOf(tier);
  const moved = Math.min(MODEL_TIERS.length - 1, Math.max(0, index + SHIFT[posture]));
  return MODEL_TIERS[moved] ?? tier;
}

/**
 * O alias que vai para a CLI.
 *
 * `undefined` quando o papel nao declara escada -- e ai a CLI usa o padrao
 * dela. Nao inventamos alias: um nome de modelo que a CLI nao conhece derruba
 * a execucao inteira, e os aliases de algumas CLIs saem do arquivo de config
 * do proprio usuario.
 */
export function modelFor(role: RoleDefinition, tier: ModelTier): string | undefined {
  return role.models?.[tier] ?? role.model;
}
