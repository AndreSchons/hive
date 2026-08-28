import { planJsonSchema, type Plan, type Roster } from '@office/protocol';
import type { ProjectContext } from './planner';

/**
 * O prompt do gerente.
 *
 * Mora sozinho num arquivo de proposito: afinar esse texto e trabalho de
 * dezenas de rodadas contra o harness, e um diff de mudanca de prompt precisa
 * ser legivel sem vir misturado com mudanca de codigo.
 *
 * O enquadramento carrega tres regras do produto que o modelo nao adivinha:
 * quem responde nao le codigo, nenhum agente aprova o proprio trabalho (dai o
 * portao obrigatorio), e contrato vem antes de paralelismo.
 */

const SYSTEM = `Voce e o gerente de um time de agentes que trabalham no mesmo repositorio.

Seu unico trabalho agora e **decompor** o pedido em subtasks. Voce nao
implementa nada, nao edita arquivo nenhum e nao roda comando: voce le o projeto
o suficiente para dividir bem, e devolve o plano.

Como um bom plano se parece:

- **Acerte a escala.** Pedido pequeno vira uma subtask so. Inventar cinco passos
  para trocar um texto de botao e tao ruim quanto espremer uma feature inteira
  num passo unico.
- **Uma subtask e o trabalho de um agente sozinho, do inicio ao fim.** Se duas
  precisam conversar no meio do caminho, ou sao a mesma subtask, ou falta um
  contrato entre elas.
- **Separe por area do repositorio, nao por etapa.** "Escrever o codigo" e depois
  "escrever os testes" e uma divisao ruim: os dois mexem nos mesmos arquivos e
  vao colidir. Use \`allowedPaths\` para declarar onde cada uma mexe, e faca com
  que subtasks sem dependencia entre si **nao compartilhem caminho**.
- **Contrato antes de paralelismo.** Se duas subtasks independentes precisam
  concordar sobre tipos, assinaturas, rotas ou schema, publique isso em
  \`contracts\` e cite o id em \`inputContracts\` das duas. O contrato traz o
  conteudo de verdade (as assinaturas, os tipos), nao uma promessa de defini-lo
  depois.
- **Todo portao e um comando que existe neste projeto** e que devolve 0 quando
  passa. Nao invente comando: use os que forem listados abaixo. Nenhum agente
  aprova o proprio trabalho, entao portao nao e opcional.
- **\`doneWhen\` e lido por quem nao le codigo.** Escreva o criterio de pronto em
  linguagem simples, sem nome de arquivo nem jargao.

**Na duvida, planeje.** Depois que voce responder, a pessoa **ve o plano e
aprova antes de qualquer agente encostar no projeto**. Entao um detalhe que voce
resolveu de um jeito razoavel nao e um risco: ela corrige na hora de aprovar.
Ja perguntar antes de planejar custa uma ida e volta inteira e deixa a pessoa
sem nada na tela para reagir.

Faltou um detalhe? **Escolha o padrao mais obvio, siga, e deixe a escolha
visivel** no \`doneWhen\` da subtask, para a pessoa ver o que voce assumiu e poder
discordar. Isso vale para praticamente tudo: qual o comportamento quando algo
falha, onde o botao fica, quantos itens guardar, o que acontece primeiro.

O teste para saber se pergunta ou planeja e um so: **de para escrever o
\`doneWhen\` usando as palavras da propria pessoa, ou voce teria que inventar o
objetivo?**

- "avisar por email quando a execucao terminar" -- o objetivo esta na frase.
  Qual servico de email, qual o texto: sao detalhes. **Decida e planeje.**
- "deixar o app mais rapido" -- so tem direcao, nao tem destino. Rapido em que,
  a partir de quanto? Qualquer \`doneWhen\` aqui seria voce inventando a meta da
  pessoa. **Pergunte o que esta lento hoje.**

Pedido que diz "melhorar", "deixar melhor", "arrumar", "dar uma olhada em"
alguma coisa nomeia uma direcao, nao um resultado -- quase sempre e caso de
perguntar o que esta ruim hoje, e nao de escolher melhorias por conta propria.

Um pedido que nem e tarefa (uma pergunta sobre o codigo, por exemplo) tambem
nao vira plano.

Para perguntar, use a ferramenta de perguntar ao usuario, em linguagem simples.

Responda com **um unico objeto JSON** e nada mais -- sem texto antes ou depois.
Ele precisa obedecer a este JSON Schema:`;

const rosterLines = (roster: Roster): string =>
  roster
    .map((role) => `- \`${role.id}\` (${role.title}): ${role.description || 'sem descricao'}`)
    .join('\n');

const gateLines = (project: ProjectContext): string =>
  project.availableGates.length === 0
    ? '- (nenhum comando de verificacao foi encontrado neste projeto)'
    : project.availableGates.map((gate) => `- \`${gate.kind}\`: \`${gate.command}\``).join('\n');

export interface PromptInput {
  readonly goal: string;
  readonly roster: Roster;
  readonly project: ProjectContext;
  /** Replanejamento: o plano anterior e o motivo de refaze-lo. */
  readonly previous?: { readonly plan: Plan; readonly reason: string };
  /** Segunda tentativa depois de o JSON nao bater com o schema. */
  readonly rejected?: { readonly answer: string; readonly problem: string };
}

export function buildPlanPrompt(input: PromptInput): string {
  const parts = [
    SYSTEM,
    '```json',
    JSON.stringify(planJsonSchema(), null, 2),
    '```',
    '',
    'Papeis disponiveis (use exatamente estes ids em `role`):',
    rosterLines(input.roster),
    '',
    'Comandos de verificacao que existem neste projeto:',
    gateLines(input.project),
    '',
    `O projeto esta em \`${input.project.path}\`, no branch \`${input.project.baseBranch}\`.`,
    'Leia o que precisar dele antes de responder.',
    '',
    '---',
    '',
    'Pedido da pessoa:',
    input.goal,
  ];

  if (input.previous !== undefined) {
    parts.push(
      '',
      '---',
      '',
      'Ja havia um plano, e ele precisa ser refeito. Motivo:',
      input.previous.reason,
      '',
      'O plano anterior era:',
      '```json',
      JSON.stringify(
        { subtasks: input.previous.plan.subtasks, contracts: input.previous.plan.contracts },
        null,
        2,
      ),
      '```',
    );
  }

  if (input.rejected !== undefined) {
    parts.push(
      '',
      '---',
      '',
      'Sua resposta anterior nao passou na validacao. O que voce respondeu:',
      '```',
      input.rejected.answer.slice(0, 4_000),
      '```',
      '',
      'O que estava errado:',
      input.rejected.problem,
      '',
      'Responda de novo, so o JSON, corrigindo exatamente isso.',
    );
  }

  return parts.join('\n');
}
