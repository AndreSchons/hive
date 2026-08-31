import { MODEL_TIERS, type RoleDefinition, type Subtask } from '@hive/protocol';
import { STATE_LABEL, TIER_LABEL, adapterLabel, dinheiro } from './describe';
import type { AgentView, WorldState } from './event-reducer';

/**
 * Uma linha da ficha. `value` e sempre uma frase que quem nao le codigo
 * consegue ler sozinha; `note` e o porque, quando existe; `detail` e o que so
 * interessa a quem le codigo -- nome canonico de modelo, branch, caminho -- e
 * fica atras de um clique, nunca solto na tela.
 */
export interface CardRow {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

export interface AgentCard {
  readonly agentId: string;
  readonly displayName: string;
  /** Papel e ferramenta, na mesma linha: "Frontend - Claude Code". */
  readonly subtitle: string;
  readonly stateLabel: string;
  readonly rows: readonly CardRow[];
  /** Detalhe tecnico, ja formatado. Sempre atras de um clique. */
  readonly detail: string;
}

/**
 * A ficha que flutua sobre o personagem clicado.
 *
 * Mora em `state/` e nao em `world/` de proposito: e aqui que se pode saber o
 * que e uma CLI e o que e um modelo. O mundo 3D so ancora a janela sobre a
 * cabeca certa -- ele nao le uma palavra do que esta escrito nela.
 *
 * Devolve `null` para agente que nao existe: clicar num boneco que sumiu do
 * estado entre o clique e o render nao pode abrir uma ficha vazia.
 */
export function buildAgentCard(
  world: WorldState,
  agentId: string,
  roles: readonly RoleDefinition[],
): AgentCard | null {
  const agent = world.agents[agentId];
  if (agent === undefined) return null;

  const role = roles.find((definition) => String(definition.id) === agent.role);
  const subtask = subtaskOf(world, agent);

  return {
    agentId,
    displayName: agent.displayName,
    subtitle: `${role?.title ?? agent.role} · ${adapterLabel(agent.adapter)}`,
    stateLabel: STATE_LABEL[agent.state],
    rows: [
      modelRow(agent, role, subtask, world.plan === null),
      doingRow(agent, world, subtask),
      ...(subtask === null ? [] : [{ label: 'Pronto quando', value: subtask.doneWhen }]),
      costRow(agent),
    ],
    detail: detailOf(agent),
  };
}

/**
 * Qual passo do plano e deste agente. A que ele esta fazendo agora, e se nao
 * estiver fazendo nada, a ultima que pegou -- quem ja entregou continua na
 * tela, e a ficha dele nao pode ficar sem contar o que ele fez.
 */
function subtaskOf(world: WorldState, agent: AgentView): Subtask | null {
  if (world.plan === null) return null;

  const mine = Object.values(world.tasks).filter((task) => task.assignedTo === agent.agentId);
  const taskId = agent.currentTaskId ?? mine[mine.length - 1]?.taskId;
  if (taskId === undefined) return null;

  return world.plan.subtasks.find((subtask) => String(subtask.id) === taskId) ?? null;
}

/**
 * Que modelo este agente esta rodando, e por que esse.
 *
 * O degrau vem do plano e o motivo tambem (`modelReason` ja e escrito para quem
 * nao le codigo). Papel sem escada roda no padrao da propria CLI, e dizer isso
 * e mais honesto que mostrar um degrau que nao existe -- a postura escolhida no
 * aval simplesmente nao afeta esse papel.
 */
function modelRow(
  agent: AgentView,
  role: RoleDefinition | undefined,
  subtask: Subtask | null,
  manual: boolean,
): CardRow {
  const escada = role?.models;
  if (escada === undefined) {
    return {
      label: 'Capricho',
      value: 'o padrao desta ferramenta',
      note: 'esta ferramenta nao deixa escolher o degrau',
    };
  }

  // Passo do gerente: o degrau e o motivo ja vieram decididos no plano, e
  // `modelReason` ja e escrito para quem nao le codigo.
  if (subtask !== null) {
    return { label: 'Capricho', value: TIER_LABEL[subtask.modelTier], note: subtask.modelReason };
  }

  // Sem passo no plano, o degrau se descobre pelo caminho inverso: qual entrada
  // da escada do papel casa com o alias que foi realmente pedido a CLI. Isso e
  // exato, e adivinhar pelo nome do modelo nao seria -- quem monta a escada e a
  // configuracao de cada usuario.
  const tier = MODEL_TIERS.find((degrau) => escada[degrau] === agent.model);
  if (tier === undefined) return { label: 'Capricho', value: 'o padrao desta ferramenta' };

  // A nota so vale na fila manual, que e o unico caminho em que a pessoa
  // escolheu o degrau com a propria mao. Numa execucao planejada quem escolheu
  // foi o sistema, e creditar a escolha a ela seria mentira.
  return manual
    ? { label: 'Capricho', value: TIER_LABEL[tier], note: 'foi o que voce escolheu na fila' }
    : { label: 'Capricho', value: TIER_LABEL[tier] };
}

/** O que ele esta fazendo neste instante, em uma frase. */
function doingRow(agent: AgentView, world: WorldState, subtask: Subtask | null): CardRow {
  // Terminou: o que ele esta fazendo e descansar, e a tarefa vira o que ele
  // **entregou**. Continuar anunciando a tarefa como "agora" faria a ficha
  // dizer que ele ainda esta nela, que e o oposto do que aconteceu.
  const entregue = subtask?.title ?? 'o que foi pedido';
  if (!agent.present) {
    return { label: 'Agora', value: 'descansando no lounge', note: `ja entregou: ${entregue}` };
  }
  if (agent.state === 'done') {
    return { label: 'Agora', value: 'acabou de entregar', note: entregue };
  }

  const task = agent.currentTaskId === null ? undefined : world.tasks[agent.currentTaskId];
  const value = task?.title ?? subtask?.title ?? 'sem tarefa no momento';
  return agent.lastSaid === null
    ? { label: 'Agora', value }
    : { label: 'Agora', value, note: agent.lastSaid };
}

/**
 * Quanto este agente ja custou.
 *
 * Lista vazia e **ausencia de informacao**, nao gasto zero: nem toda CLI
 * reporta consumo, e escrever "US$ 0,00" ali diria que foi de graca -- que e a
 * unica coisa que este numero nao pode dizer.
 *
 * Com mais de um modelo, a repartição vira a nota: uma execucao mistura
 * modelos, e o total sozinho esconde de onde o dinheiro saiu.
 */
function costRow(agent: AgentView): CardRow {
  if (agent.usage.length === 0) {
    return { label: 'Ja custou', value: 'esta ferramenta nao informa o custo' };
  }

  const total = agent.usage.reduce((sum, item) => sum + item.costUsd, 0);
  if (agent.usage.length === 1) return { label: 'Ja custou', value: dinheiro(total) };

  const note = agent.usage
    .map((item) => `${shortModel(item.model)} ${dinheiro(item.costUsd)}`)
    .join(' · ');
  return { label: 'Ja custou', value: dinheiro(total), note };
}

/**
 * `claude-sonnet-4-5-20250929` -> `sonnet`. O nome canonico carrega fornecedor,
 * versao e data, e nenhum dos tres ajuda a comparar dois modelos lado a lado --
 * o que distingue e a familia. O nome inteiro continua no detalhe tecnico.
 */
export function shortModel(model: string): string {
  const parts = model.split('-').filter((part) => !/^\d/.test(part));
  return parts.length > 1 ? (parts[1] ?? model) : model;
}

/** Tudo que e detalhe tecnico, junto e atras de um clique. */
function detailOf(agent: AgentView): string {
  const linhas = [
    `agente: ${agent.agentId}`,
    `papel: ${agent.role}`,
    `cli: ${agent.adapter}`,
    ...(agent.model === null ? [] : [`modelo pedido: ${agent.model}`]),
    ...agent.usage.map(
      (item) =>
        `modelo usado: ${item.model} - ${dinheiro(item.costUsd)} em ${item.tokens.toLocaleString('pt-BR')} tokens`,
    ),
    `copia: ${agent.worktreePath}`,
    ...(agent.branch === null ? [] : [`branch: ${agent.branch}`]),
  ];
  return linhas.join('\n');
}
