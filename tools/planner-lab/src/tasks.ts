/**
 * As dez tasks de exemplo.
 *
 * Elas nao sao variacoes do mesmo pedido: cada uma testa uma faixa diferente
 * de julgamento, porque um planner so presta se acerta a **escala**. Inventar
 * cinco passos para trocar um texto e tao ruim quanto espremer uma feature
 * inteira num passo so.
 *
 * Saem do `## O que ainda nao existe` do CLAUDE.md -- sao proximos passos reais
 * deste repositorio, entao os planos podem ser julgados por quem o conhece.
 */
export interface ExampleTask {
  readonly id: string;
  /** O pedido como uma pessoa escreveria. Sem jargao de plano. */
  readonly goal: string;
  /** O que esta task existe para descobrir sobre o planner. */
  readonly probes: string;
  /**
   * Quando o desfecho certo e binario, declare-o: o harness cobra sozinho.
   * Ausente = so da para julgar lendo, e o harness nao opina.
   *
   * Existe porque afinar o prompt para planejar mais quebrou, em silencio, a
   * capacidade de recusar -- e isso so apareceu porque alguem leu a saida
   * inteira. Regressao que depende de leitura atenta e regressao que passa.
   */
  readonly expectStatus?: 'planned' | 'needs_input';
  /** O que se espera ver. Nao e assercao: e o que voce confere lendo. */
  readonly expect: string;
}

export const TASKS: readonly ExampleTask[] = [
  {
    id: 'trivial',
    expectStatus: 'planned',
    goal: 'O botao "trocar" no topo da barra lateral devia dizer "trocar projeto".',
    probes: 'escala minima',
    expect: 'Uma subtask so. Se virar tres, o planner infla trabalho pequeno.',
  },
  {
    id: 'ambigua',
    expectStatus: 'needs_input',
    goal: 'Melhorar a tela inicial.',
    probes: 'saber que nao sabe',
    expect: 'needs_input. Nao ha como planejar isso sem perguntar o que incomoda.',
  },
  {
    id: 'nao-e-tarefa',
    expectStatus: 'needs_input',
    goal: 'Por que o adaptador do Kimi usa ACP em vez do modo prompt?',
    probes: 'pedido que e pergunta',
    expect: 'needs_input, ou uma subtask de leitura. Nunca um plano de implementacao.',
  },
  {
    id: 'contrato-obvio',
    expectStatus: 'planned',
    goal: 'Quero ver os agentes andando pelo escritorio 3D em vez de tudo parado.',
    probes: 'contrato antes de paralelismo',
    expect:
      'Separa o estado derivado dos eventos (protocol/hub state) do desenho 3D ' +
      '(hub/world), e publica um contrato ligando os dois. Sem contrato, as duas ' +
      'metades nao se encontram.',
  },
  {
    id: 'portoes-de-verdade',
    expectStatus: 'planned',
    goal: 'Antes de aceitar o trabalho de um agente, rodar o typecheck na copia dele e so integrar se passar.',
    probes: 'fidelidade ao repositorio',
    expect:
      'Deve notar que a worktree nasce sem node_modules -- esta escrito no CLAUDE.md. ' +
      'Um plano que ignora isso planeja contra um projeto imaginario.',
  },
  {
    id: 'atravessa-tudo',
    expectStatus: 'planned',
    goal: 'Adicionar um terceiro agente de CLI, o Codex, junto com os dois que ja existem.',
    probes: 'trabalho que cruza o repositorio inteiro',
    expect:
      'protocol, agents, shell e hub. Deve virar varias subtasks com dependencia real, ' +
      'nao uma subtask gigante nem dez passos picados.',
  },
  {
    id: 'paralelo-arriscado',
    expectStatus: 'planned',
    goal: 'Rodar dois agentes ao mesmo tempo em vez de um de cada vez.',
    probes: 'consciencia de conflito',
    expect:
      'allowedPaths que nao se sobrepoem entre subtasks irmas. Se elas colidirem, ' +
      'o planner acabou de agendar o merge conflict que o sistema existe para evitar.',
  },
  {
    id: 'refactor-grande',
    expectStatus: 'planned',
    goal: 'O run-supervisor esta grande demais e faz coisas demais. Quebrar em partes menores.',
    probes: 'refactor sem feature nova',
    expect:
      'Sequencial, com portao a cada passo. Refactor paralelo em cima do mesmo arquivo ' +
      'e a receita do conflito.',
  },
  {
    id: 'pede-decisao',
    goal: 'Guardar as execucoes antigas para a pessoa poder reabrir e assistir de novo.',
    probes: 'decisao de produto escondida num pedido tecnico',
    expect:
      'Ou pergunta (quantas guardar? apagar quando?), ou declara a escolha em doneWhen. ' +
      'Escolher em silencio e o que nao pode.',
  },
  {
    id: 'ja-existe',
    goal: 'Validar que o plano do gerente nao tem dependencia circular.',
    probes: 'ler antes de planejar',
    expect:
      'Isso ja existe (`findCycle` em packages/protocol/src/plan.ts). Um planner que ' +
      'leu o projeto diz isso; um que nao leu planeja construir de novo.',
  },
];

export const findTask = (id: string): ExampleTask | undefined =>
  TASKS.find((task) => task.id === id);
