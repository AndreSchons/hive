import {
  newQuestionId,
  type AgentId,
  type BlockCause as QuestionCause,
  type QuestionId,
  type TaskId,
} from '@hive/protocol';
import type { BudgetVerdict } from './budget';
import type { GateFailure } from './gate-runner';

/** Por que a execucao parou. Determina o texto da pergunta. */
export type BlockCause =
  | { readonly kind: 'agent_asked'; readonly question: string; readonly context: string }
  | { readonly kind: 'gate_failed'; readonly result: GateFailure }
  | { readonly kind: 'budget'; readonly verdict: BudgetVerdict }
  | { readonly kind: 'merge_conflict'; readonly files: readonly string[] }
  | { readonly kind: 'agent_crashed'; readonly reason: string; readonly detail?: string };

export interface EscalationRequest {
  readonly agentId: AgentId;
  readonly taskId?: TaskId;
  readonly cause: BlockCause;
  /** Qual tentativa acabou de terminar mal. Comeca em 1. */
  readonly attempt: number;
}

/**
 * Uma pergunta que quem nao le codigo consegue responder: sem jargao, sem
 * stack trace, com opcoes concretas sempre que possivel.
 */
export interface HumanQuestion {
  readonly questionId: QuestionId;
  readonly question: string;
  /** Por que estamos perguntando, em uma frase. */
  readonly context: string;
  /** Como o 3D anima a parada e como o hub agrupa a pergunta. */
  readonly cause: QuestionCause;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly allowFreeText: boolean;
}

/** O que fazer com o que a pessoa responder. */
export type AnswerUse =
  /** Devolver a resposta para o agente que estava travado, na mesma conversa. */
  | 'session'
  /** Comecar outra tentativa levando a resposta como instrucao extra. */
  | 'restart'
  /** Chamar alguem para juntar o trabalho dos dois lados. */
  | 'resolve';

export type EscalationDecision =
  /** Da para resolver sozinho: tenta de novo com esta instrucao extra. */
  | { readonly action: 'retry'; readonly guidance: string }
  /**
   * Para tudo e pergunta. `guidance` e o que o agente ouve se a pessoa mandar
   * continuar -- fica aqui, e nao em quem coordena, para todo texto que um
   * agente le sair de um lugar so.
   */
  | {
      readonly action: 'ask';
      readonly question: HumanQuestion;
      readonly onAnswer: AnswerUse;
      readonly guidance: string;
    }
  /** Sem saida: encerra a execucao e explica. */
  | { readonly action: 'abort'; readonly reason: string };

/**
 * Escalonamento e a experiencia principal do produto, nao um caminho de erro.
 * Esta politica decide entre tentar de novo, perguntar ou desistir -- e quando
 * pergunta, traduz a causa tecnica para linguagem do usuario.
 */
export interface EscalationPolicy {
  decide(request: EscalationRequest): EscalationDecision;
}

/** Ids de opcao. Viajam ate o hub e voltam em `human.answered.optionId`. */
export const OPTION_RETRY = 'tentar';
export const OPTION_STOP = 'parar';
export const OPTION_RESOLVE = 'resolver';

const KEEP_GOING = { id: OPTION_RETRY, label: 'Tentar de novo' } as const;
const GIVE_UP = { id: OPTION_STOP, label: 'Parar e me mostrar o que aconteceu' } as const;

export interface DefaultEscalationOptions {
  /**
   * Quantas tentativas o agente ganha antes de a duvida subir. Duas: uma
   * segunda chance com o erro colado no pedido e o tipo de coisa que o modelo
   * conserta sozinho -- e a terceira, na pratica, so repete a segunda. E a
   * mesma conta que o gerente ja faz quando o JSON do plano nao valida.
   */
  readonly maxAttempts?: number;
  /** Quanto da saida do portao entra no pedido de correcao. */
  readonly maxGuidanceChars?: number;
  readonly newQuestionId?: () => QuestionId;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_GUIDANCE_CHARS = 4_000;

export class DefaultEscalationPolicy implements EscalationPolicy {
  constructor(private readonly options: DefaultEscalationOptions = {}) {}

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private question(
    parts: Omit<HumanQuestion, 'questionId'>,
  ): HumanQuestion {
    const mint = this.options.newQuestionId ?? newQuestionId;
    return { questionId: mint(), ...parts };
  }

  decide(request: EscalationRequest): EscalationDecision {
    const { cause, attempt } = request;

    switch (cause.kind) {
      // A pergunta do proprio agente sobe como ele fez: quem sabe o que falta
      // e ele, e reescrever aqui trocaria a duvida real por uma generica.
      case 'agent_asked':
        return {
          action: 'ask',
          onAnswer: 'session',
          // A propria resposta e a instrucao: nao ha o que acrescentar a ela.
          guidance: '',
          question: this.question({
            question: cause.question,
            context: cause.context,
            cause: 'agent_asked',
            options: [],
            allowFreeText: true,
          }),
        };

      case 'gate_failed': {
        if (attempt < this.maxAttempts) {
          return { action: 'retry', guidance: this.gateGuidance(cause.result) };
        }
        return {
          action: 'ask',
          onAnswer: 'restart',
          guidance: this.gateGuidance(cause.result),
          question: this.question({
            question: 'A verificacao do projeto continua reprovando esse trabalho. O que voce quer fazer?',
            context: `${cause.result.summary} Eu ja pedi uma correcao e o problema continua.`,
            cause: 'gate_failed',
            options: [KEEP_GOING, GIVE_UP],
            // Texto livre vira instrucao extra: quem conhece o projeto costuma
            // saber a pista que falta, e digitar e mais rapido que explicar.
            allowFreeText: true,
          }),
        };
      }

      case 'budget':
        return {
          action: 'ask',
          onAnswer: 'restart',
          guidance: [
            'Voce ja gastou boa parte do tempo combinado neste passo e a pessoa autorizou continuar.',
            'Va direto ao que falta e evite repetir o que ja tentou.',
          ].join(' '),
          question: this.question({
            question: 'Esse trabalho esta demorando mais do que o combinado. Quer que eu continue?',
            context: budgetContext(cause.verdict),
            cause: 'budget',
            options: [
              { id: OPTION_RETRY, label: 'Continuar tentando' },
              GIVE_UP,
            ],
            allowFreeText: true,
          }),
        };

      case 'merge_conflict': {
        const lista = cause.files.slice(0, 3).join(', ');
        return {
          action: 'ask',
          onAnswer: 'resolve',
          guidance: '',
          question: this.question({
            question: 'Dois agentes mexeram no mesmo lugar. Como quer que eu resolva?',
            context: `Eles editaram ${lista} de formas diferentes, e eu nao sei qual das duas versoes voce quer manter.`,
            cause: 'merge_conflict',
            options: [
              { id: OPTION_RESOLVE, label: 'Deixar um agente juntar os dois trabalhos' },
              { id: OPTION_STOP, label: 'Parar por aqui e me mostrar o que aconteceu' },
            ],
            allowFreeText: false,
          }),
        };
      }

      case 'agent_crashed': {
        if (attempt < this.maxAttempts) {
          return {
            action: 'retry',
            guidance: [
              'A tentativa anterior parou no meio do caminho antes de terminar.',
              'Continue de onde parou e conclua a tarefa.',
            ].join(' '),
          };
        }
        return {
          action: 'ask',
          onAnswer: 'restart',
          guidance: 'A tentativa anterior parou no meio do caminho. Recomece e conclua a tarefa.',
          question: this.question({
            question: 'O agente parou no meio do caminho duas vezes. Quer que eu tente mais uma?',
            context: cause.reason,
            cause: 'agent_crashed',
            options: [KEEP_GOING, GIVE_UP],
            allowFreeText: true,
          }),
        };
      }
    }
  }

  /**
   * O pedido de correcao vai para o agente, entao aqui detalhe tecnico e o
   * ponto: e a saida do compilador colada no pedido que faz o modelo consertar
   * sozinho. A ultima frase nao e enfeite -- sem ela o caminho mais curto para
   * o portao ficar verde e apagar o teste que reprovou.
   */
  private gateGuidance(result: GateFailure): string {
    const max = this.options.maxGuidanceChars ?? DEFAULT_GUIDANCE_CHARS;
    const detail = result.detail.length <= max ? result.detail : result.detail.slice(-max);

    return [
      `O que voce entregou nao passou na verificacao do projeto: \`${result.command}\`.`,
      '',
      'Saida do comando:',
      '```',
      detail,
      '```',
      '',
      'Corrija a causa e rode esse mesmo comando ate ele passar.',
      'Nao apague nem desative teste, verificacao ou regra para o comando passar,',
      'e nao mude o objetivo da tarefa: o que precisa mudar e o codigo.',
    ].join('\n');
  }
}

/** Por que paramos, sem numero de turno nem assinatura de ferramenta na frente. */
function budgetContext(verdict: BudgetVerdict): string {
  switch (verdict.status) {
    case 'looping':
      return `O agente tentou a mesma coisa ${verdict.occurrences} vezes seguidas e nao saiu do lugar.`;
    case 'exceeded':
    case 'warning':
      return verdict.kind === 'time'
        ? `Ja se passaram ${Math.round(verdict.used / 60_000)} minutos nesse mesmo passo.`
        : `O agente ja fez ${verdict.used} tentativas nesse mesmo passo.`;
    case 'ok':
      return 'O agente parou sem terminar.';
  }
}
