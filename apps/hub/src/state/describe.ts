import { parallelismGain, type AnyEvent, type ModelTier } from '@hive/protocol';

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'ask';

export interface FeedItem {
  readonly seq: number;
  readonly ts: number;
  readonly type: AnyEvent['type'];
  readonly text: string;
  readonly tone: Tone;
  /** Detalhe tecnico, escondido atras de um clique. */
  readonly detail?: string;
}

const shorten = (text: string, max = 90): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Traduz um evento para uma frase que quem nao le codigo entende. Este e o
 * unico lugar do renderer que decide texto de evento -- e o unico lugar onde
 * detalhe tecnico pode aparecer, sempre separado, nunca no corpo da frase.
 */
export function describeEvent(event: AnyEvent): FeedItem {
  const base = { seq: event.seq, ts: event.ts, type: event.type } as const;
  const item = (text: string, tone: Tone = 'neutral', detail?: string): FeedItem =>
    detail === undefined ? { ...base, text, tone } : { ...base, text, tone, detail };

  switch (event.type) {
    case 'run.started':
      return item(`Comecou: ${event.payload.goal}`);
    case 'run.completed': {
      const { summary, costUsd } = event.payload;
      // O custo entra na frase de fechamento porque quem paga e a pessoa: e a
      // unica linha do feed em que esse numero e a informacao principal.
      return costUsd > 0 ? item(`${summary} Custou ${dinheiro(costUsd)}.`, 'good') : item(summary, 'good');
    }
    case 'run.failed':
      return item(event.payload.reason, 'bad', event.payload.detail);

    case 'plan.created':
      return item(`Plano pronto com ${event.payload.plan.subtasks.length} etapas`, 'good');
    case 'plan.revised':
      return item(`Plano ajustado: ${event.payload.reason}`, 'warn');
    case 'contract.published':
      return item(`Combinado antes de dividir o trabalho: ${event.payload.contract.title}`, 'good');
    case 'plan.measured': {
      const { savedMs, worthIt } = parallelismGain(event.payload);
      if (event.payload.peakParallel < 2) {
        return item('Os passos correram um de cada vez: nenhum par podia dividir o projeto.');
      }
      // A frase diz o que a pessoa ganhou, nunca quantos processos rodaram.
      return worthIt
        ? item(`Trabalhando em dupla, ${segundos(savedMs)} a menos de espera`, 'good')
        : item(
            `Trabalhar em dupla nao compensou desta vez: juntar custou mais que correr junto`,
            'warn',
            [
              `economizado: ${segundos(savedMs)}`,
              `juntando: ${segundos(event.payload.mergeMs)}`,
              `desfazendo colisao: ${segundos(event.payload.conflictMs)} em ${event.payload.conflicts}`,
              `passos que esperaram por area compartilhada: ${event.payload.heldForOverlap}`,
            ].join('\n'),
          );
    }

    case 'agent.spawned':
      return item(`${event.payload.displayName} entrou no escritorio`);
    case 'agent.state_changed':
      return item(event.payload.reason ?? `Agora esta ${STATE_LABEL[event.payload.to]}`);
    case 'agent.despawned':
      return item('Saiu do escritorio');
    case 'agent.usage':
      return item(
        `Gastou ${dinheiro(event.payload.costUsd)} usando ${event.payload.model}`,
        'neutral',
        [
          `entrada: ${event.payload.inputTokens}`,
          `saida: ${event.payload.outputTokens}`,
          `cache escrito: ${event.payload.cacheCreationTokens}`,
          `cache lido: ${event.payload.cacheReadTokens}`,
        ].join('\n'),
      );

    case 'task.assigned':
      return item(`Entregou "${event.payload.title}" para o especialista`);
    case 'task.started':
      return item(`Comecou "${event.payload.title}"`);
    case 'task.progress':
      return item(event.payload.note);
    case 'task.completed':
      return item(event.payload.summary, 'good');
    case 'task.failed':
      return item(event.payload.reason, 'bad', event.payload.detail);

    case 'gate.started':
      return item(`Verificando o trabalho (${GATE_LABEL[event.payload.kind]})`);
    case 'gate.passed':
      return item(`Verificacao passou (${GATE_LABEL[event.payload.kind]})`, 'good');
    case 'gate.failed':
      return item(event.payload.summary, 'bad', event.payload.detail);

    case 'agent.message':
      return item(shorten(event.payload.summary), event.payload.intent === 'warn' ? 'warn' : 'neutral');
    case 'agent.handoff':
      return item(`Passou ${event.payload.artifact} adiante`);

    case 'human.question_raised':
      return item(event.payload.question, 'ask');
    case 'human.answered':
      return item(`Voce respondeu: ${shorten(event.payload.answer, 60)}`, 'good');

    case 'tool.call':
      return item(event.payload.summary);
    case 'tool.result':
      // Sucesso e o caso comum e nao merece destaque: so a falha se destaca.
      return item(event.payload.summary, event.payload.ok ? 'neutral' : 'bad', event.payload.detail);
    case 'file.changed':
      return item(`${CHANGE_LABEL[event.payload.change]} ${event.payload.path}`);

    case 'worktree.created':
      return item('Foi trabalhar numa copia separada do projeto');
    case 'worktree.conflict': {
      const { files } = event.payload;
      return item(
        `Dois agentes mexeram ${files.length === 1 ? 'no mesmo arquivo' : 'nos mesmos arquivos'} e nao deu para juntar sozinho`,
        'warn',
        files.join('\n'),
      );
    }
    case 'worktree.merged':
      return item(
        event.payload.resolvedBy === undefined
          ? `Juntou o trabalho ao projeto (${event.payload.filesChanged} arquivos)`
          : `Um agente juntou os dois trabalhos e integrou (${event.payload.filesChanged} arquivos)`,
        'good',
      );
    case 'worktree.removed':
      return event.payload.reason === 'merged'
        ? item('Fechou a copia de trabalho')
        : item('Descartou a copia sem integrar nada', 'warn');

    case 'budget.warning':
      return item(`Chegando no limite de ${BUDGET_LABEL[event.payload.kind]}`, 'warn');
    case 'budget.exceeded':
      return item(`Passou do limite de ${BUDGET_LABEL[event.payload.kind]} e parou`, 'bad');
    case 'loop.detected':
      return item(`Tentou a mesma coisa ${event.payload.occurrences} vezes e parou`, 'warn');
  }
}

/**
 * Nome da CLI por tras de um papel. O id e aberto (papeis sao configuracao),
 * entao um adaptador que este mapa nao conhece aparece pelo proprio id em vez
 * de sumir da tela.
 */
const ADAPTER_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  mock: 'Simulado',
};

export const adapterLabel = (adapter: string): string => ADAPTER_LABEL[adapter] ?? adapter;

/**
 * Como cada degrau de modelo se chama para quem nao le codigo. O nome do modelo
 * em si ("sonnet") nao diz nada para essa pessoa; o que ela precisa saber e se
 * aquele passo vai no barato ou no caprichado.
 *
 * Mora aqui, e nao na tela que o usa, porque duas telas mostram o degrau -- o
 * plano antes de aprovar e o personagem durante a execucao -- e chamar o mesmo
 * degrau de dois nomes faria a pessoa achar que sao coisas diferentes.
 */
export const TIER_LABEL: Record<ModelTier, string> = {
  economico: 'economico',
  padrao: 'equilibrado',
  caprichado: 'caprichado',
};

export const STATE_LABEL = {
  idle: 'livre',
  thinking: 'pensando',
  working: 'trabalhando',
  blocked: 'travado',
  talking: 'conversando',
  done: 'pronto',
} as const;

const GATE_LABEL = {
  typecheck: 'tipos',
  build: 'compilacao',
  test: 'testes',
  lint: 'padrao de codigo',
  custom: 'verificacao propria',
} as const;

const CHANGE_LABEL = { created: 'Criou', modified: 'Mudou', deleted: 'Apagou' } as const;

const BUDGET_LABEL = { turns: 'tentativas', time: 'tempo', cost: 'custo' } as const;

/**
 * Duracao como gente fala. Milissegundo nao diz nada para quem esta esperando:
 * o que importa e se foram segundos ou minutos.
 */
function segundos(ms: number): string {
  if (ms < 1_000) return 'menos de um segundo';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutos = Math.floor(ms / 60_000);
  const resto = Math.round((ms % 60_000) / 1_000);
  return resto === 0 ? `${minutos}min` : `${minutos}min ${resto}s`;
}

/**
 * Custo em dolar, como se le em portugues. Passo pequeno custa fracao de
 * centavo, e arredondar para dois digitos mostraria "US$ 0,00" -- que se le
 * como "de graca" e e a unica coisa que este numero nao pode dizer.
 */
export function dinheiro(valor: number): string {
  const casas = valor > 0 && valor < 0.01 ? 4 : 2;
  return `US$ ${valor.toFixed(casas).replace('.', ',')}`;
}
