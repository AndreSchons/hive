# Agent Office

App desktop que orquestra as CLIs de agente ja instaladas no terminal do usuario
(Claude Code, Kimi) trabalhando juntas no mesmo repositorio, com a execucao
visualizada como um escritorio 3D isometrico.

O publico e quem nao le codigo. A pessoa descreve o que quer, o sistema coordena
os agentes ate a entrega e **para para perguntar em linguagem simples** quando
trava. Escalonamento e a experiencia principal, nao um caminho de erro.

## Regras que valem em todo o codigo

- **Agentes sao subprocessos de CLIs que ja existem.** Nao ha runtime de agente
  proprio e nao se chama API de modelo direto. O orquestrador roda a CLI como
  processo filho com output em stream JSON e converte esse stream em eventos do
  dominio. Cada CLI e um `AgentAdapter`.
- **Isolamento por git worktree.** Cada agente ativo trabalha numa worktree
  propria. Dois agentes nunca compartilham diretorio. Integrar e etapa explicita
  do gerente, nunca efeito colateral.
- **Contrato antes de paralelismo.** Antes de dois especialistas partirem em
  paralelo, o gerente publica os contratos que ligam o trabalho deles. Esse
  artefato entra como input obrigatorio de cada subtask paralela.
- **Nenhum agente aprova o proprio trabalho.** Toda subtask tem portao de
  verificacao objetivo (`typecheck`, `build`, `test`, `lint`). "Terminei" sem
  portao verde nao e entrega aceita.
- **Limites duros.** Orcamento de turnos e de tempo por agente, e deteccao de
  repeticao. Estourou, para e pergunta -- nunca segue tentando as cegas.
- **Nunca despeje detalhe tecnico no usuario.** Stack trace, saida de compilador
  e exit code vivem em `detail`, separados da frase principal, atras de um
  clique. A frase principal e sempre respondivel por quem nao le codigo.
- **Log append-only.** Todo evento vai para SQLite com numero de sequencia. O
  mundo 3D reproduz uma execucao inteira a partir do log, sem rodar agente.

## Fronteiras entre pacotes

```
packages/protocol      nao depende de nada. Todo o resto depende dele.
packages/store         protocol
packages/agents        protocol
packages/coordination  protocol, agents          -- nunca apps/*
apps/shell             protocol, store, agents, coordination, simulator
apps/hub               protocol                  -- e so
tools/simulator        protocol, store
tools/planner-lab      protocol, agents, coordination
```

Regras que nao se negociam:

- `packages/protocol` nao importa nada do workspace. E a fronteira do sistema.
- `apps/hub` importa **apenas** `@office/protocol`. Nao conhece SQLite, Electron,
  CLI nem subprocesso. Se o hub precisa de um dado novo, ele entra no protocol
  como evento ou comando -- nunca como import atravessado.
- `packages/coordination` nao importa nada de `apps/`. O orquestrador nao sabe o
  que e camera, mesa ou animacao: ele **so emite eventos**.
- `apps/hub/src/world/` (o 3D) nao conhece agente, CLI nem modelo. Consome estado
  derivado de eventos e mapeia para animacao. Se um componente 3D precisa saber
  qual CLI rodou, o desenho esta errado.
- So `packages/store` toca SQLite. Nenhum outro pacote abre banco.
- Nada escreve em `events` fora do `EventStore`. Triggers no banco recusam
  `UPDATE` e `DELETE` nessa tabela.

## Tipos

Os tipos TypeScript sao **gerados a partir dos schemas Zod**, nunca escritos a
mao em paralelo. O catalogo de eventos vive em `packages/protocol/src/events/`,
um arquivo por dominio, e `events/index.ts` monta o envelope e a uniao
discriminada. Um teste compara a uniao com o catalogo e falha se alguem
adicionar um payload sem registrar.

`strict` ligado com extras (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`). Sem `any` e
sem `as` para silenciar erro -- onde o dispatch dinamico sobre uniao pediria
assercao, use tipo mapeado (ver `apps/shell/src/main/ipc.ts`).

## Comandos

```
pnpm build       # todos os pacotes
pnpm typecheck
pnpm test
pnpm dev         # vite + electron com recarga
pnpm app         # compila e abre o app
pnpm app:nosandbox   # idem, sem o sandbox do Chromium (ver nota de Linux)
pnpm --filter @office/simulator start -- --db <caminho> --project <pasta>
pnpm plan-lab -- --task all --project .   # so o gerente, sem executar nada
```

## Como a CLI do Claude Code entra

`packages/agents/src/claude/` roda a CLI ja instalada como processo filho, em
NDJSON nos dois sentidos. Tres detalhes que custaram para descobrir e que o
codigo depende:

- **`--permission-prompt-tool stdio` nao e opcional.** Sem essa flag a CLI decide
  permissao sozinha e so avisa depois. Com ela, a CLI **suspende o agente** e
  manda `control_request/can_use_tool`, e so continua quando escrevemos um
  `control_response` no stdin. E dai que sai o estado `blocked` de verdade.
- **Pergunta de produto chega pelo mesmo canal.** `AskUserQuestion` vem como
  `can_use_tool` com `requires_user_interaction: true` e as opcoes estruturadas.
  A resposta volta em `updatedInput.answers`, **chaveada pelo texto da pergunta**,
  e o input original tem que ir inteiro junto -- a ferramenta revalida os campos
  dela (`header`, `multiSelect`).
- **Fechar o stdin no `result` e obrigatorio.** Enquanto ele estiver aberto a CLI
  espera outro turno e nunca sai, e a execucao nunca fecha.

O conteudo do pensamento vem redigido (so a assinatura): da para saber *que* o
agente pensou, nunca *o que*. Cancelamento chega como `error_during_execution`
com exit 1, igual a uma queda -- quem separa os dois e `terminal_reason`.

A politica de permissao (`claude/permission.ts`) libera leitura e escrita dentro
da pasta do projeto e escala o resto. As fixtures em `packages/agents/test/`
sao NDJSON gravado da CLI de verdade: e contra elas que o parser e testado.

## Como a CLI do Kimi entra

`packages/agents/src/kimi/` fala **Agent Client Protocol** (`kimi acp`), JSON-RPC
2.0 em NDJSON pelos dois sentidos. O modo obvio -- `kimi -p --output-format
stream-json` -- foi descartado depois de lido o binario, e vale registrar por que
antes que alguem tente de novo:

- O modo prompt chama `setMode("auto")`, que o proprio `--help` descreve como
  *"fully autonomous, the agent will not ask questions"*. **Nunca bloqueia.**
- `writeThinkingDelta()` tem corpo vazio: em JSON o pensamento e descartado.
- Resultado de ferramenta vira string crua, sem contagem de linha nem sinal de erro.
- Nao existe `--input-format`: stdin nao e canal, entao `answer()` e impossivel.

Pelo ACP tudo isso existe. Tres detalhes que o codigo depende:

- **O bloco de diff chega no update `in_progress`, nunca no `completed`.** Quem
  olhasse so a frame final nunca veria mudanca de arquivo nenhuma.
- **`Write` nao manda bloco de diff.** So `rawInput.content`. Criar e sobrescrever
  sao indistinguiveis pelo stream, entao `AcpTranslator` recebe um `exists`
  injetado e pergunta ao disco **antes** da escrita -- no `in_progress`, que
  chega antes de o arquivo mudar.
- **A resposta JSON-RPC nao pode ser descrita como "`method` ausente".** Uma chave
  declarada como `z.undefined()` continua obrigatoria no Zod, e toda resposta era
  descartada em silencio. A uniao tenta pedido e notificacao primeiro; a resposta
  e o que sobra.

Os ids de opcao de permissao (`approve_once`, `reject`) sao do Kimi e viajam no
proprio pedido -- nunca invente um.

A politica de permissao e **uma so** (`packages/agents/src/permission.ts`), com
entrada agnostica de CLI. O que o sistema deixa um agente fazer nao pode depender
de qual CLI ele e.

Ajuda que as duas usem os mesmos nomes de ferramenta (`Read`, `Write`, `Edit`,
`Bash`, `Glob`, `Grep`, `WebSearch`), entao `tool-summary.ts` e as listas de
`permission.ts` valem para as duas sem traducao. O `kind` do ACP entra como rede
de seguranca para o que nao estiver nessas listas, nao como caminho principal.

## Como o gerente planeja

`packages/coordination/src/agent-planner.ts` roda o gerente na mesma
`AgentAdapter` que executa uma subtask, com duas diferencas que importam:

- **Modo somente-leitura** (`AgentRunRequest.readOnly`). Planejar e olhar, e sem
  isso o gerente teria permissao de escrita sobre a pasta inteira do usuario so
  para decidir o que fazer. A politica continua **uma so**: o modo e parametro
  de `decidePermission`, nunca uma segunda politica.
- **A resposta e parseada como JSON**, nao aceita como texto. Isso so funciona
  porque o desfecho carrega o texto final da CLI inteiro -- `AgentOutcome`
  `completed.summary` e cru; quem corta em 280 para caber no evento e o
  `translate`. Inverter isso deixa o plano pela metade sem erro nenhum.

O que o modelo preenche e `planDraftSchema`, nao `planSchema`. A divisao e
deliberada: ele **nao** inventa `planId`, `runId`, `revision`, `createdBy`, id
de portao nem orcamento -- um gerente que define o proprio teto de turnos nao
tem teto. Mas **precisa** inventar id de subtask e de contrato, porque e com
eles que liga `dependsOn` e `inputContracts`; como o id e string livre, um slug
legivel (`"schema-do-login"`) passa e se le muito melhor que `tsk_a1b2c3d4`.

O JSON Schema que vai no prompt sai de `z.toJSONSchema(planDraftSchema,
{ io: 'input' })`. Escrever esse contrato a mao criaria duas fontes de verdade
que divergem em silencio: o modelo obedeceria uma e o parse cobraria a outra.

A validacao de grafo (`refinePlanGraph`) e a mesma para o rascunho e para o
plano completo, pela mesma razao.

JSON fora do schema ganha **uma** segunda chance, com o erro do Zod colado no
prompt -- e o tipo de erro que o modelo conserta sozinho. Duas falhas viram
pergunta, nunca um terceiro turno.

### Quando o gerente pergunta em vez de planejar

O criterio esta no `prompt.ts` e foi calibrado contra o harness, nao escolhido
no escuro: **da para escrever o `doneWhen` com as palavras da propria pessoa, ou
o gerente teria que inventar o objetivo?** Detalhe em aberto ("o que fazer
quando reprovar") ele decide e registra no `doneWhen`; objetivo em aberto
("deixar melhor") ele pergunta.

Duas coisas sustentam isso e nao podem sair do prompt:

- **O gerente precisa saber que existe o portao de aprovacao.** Sem essa frase
  ele trata todo detalhe em aberto como risco e pergunta, porque perguntar
  parece de graca. Sabendo que a pessoa ve e aprova o plano antes de qualquer
  agente encostar no projeto, o calculo fica certo.
- **Os exemplos do prompt nao podem ser as tasks do harness.** Usar o texto das
  tasks ali seria ensinar para a prova, e o harness deixaria de medir.

Empurrar o gerente para planejar mais quebra, com facilidade, a capacidade de
recusar -- ja aconteceu uma vez: "melhorar a tela inicial" virou uma reforma
inteira inventada. Por isso as tasks de desfecho binario declaram
`expectStatus`, e o harness sai com codigo diferente de zero quando uma regride.

### O harness

`tools/planner-lab` roda **so** o gerente sobre dez tasks de exemplo, sem
executar nada. Uma rodada custa dez planejamentos em vez de dez execucoes com
agentes mexendo em worktrees, e e isso que torna afinar `prompt.ts` viavel --
esse texto mora sozinho num arquivo para que o diff de uma mudanca de prompt
seja legivel.

`checks.ts` nao julga qualidade: mede o que e objetivo e some quando voce esta
lendo o oitavo plano seguido. A checagem que mais importa e **sobreposicao de
`allowedPaths` entre subtasks que nao dependem uma da outra** -- elas podem
rodar juntas e mexem no mesmo lugar, entao e o preditor direto do conflito de
merge que o resto do sistema existe para detectar e parar.

As tasks com desfecho binario (`expectStatus`) o harness cobra sozinho e o
processo sai com codigo diferente de zero se alguma regredir -- as outras duas
aceitam os dois desfechos e ficam como leitura.

```
pnpm plan-lab -- --task all --project . --out /tmp/planos
```

## Isolamento e integracao

`GitWorktreeManager` (`packages/agents/src/git/`) roda `git` de verdade. Conflito,
arvore suja e pasta sem repositorio sao **respostas**, nunca excecoes.

- A worktree mora **fora** do repositorio (`<userData>/worktrees/<runId>/<agentId>`).
  Dentro dele ela apareceria como pasta nao rastreada no `git status` de quem usa
  o projeto, e um agente poderia commitar a copia do outro.
- **Quem commita e o supervisor**, nao a CLI: o agente nao commita sozinho e a
  politica escala `Bash`. Sem isso nao existe o que mergear.
- `merge` conflitado deixa o merge **em curso** de proposito. E o que permite
  resolver depois sem refazer nada -- e e literalmente "detectar e parar".
- Antes de fechar um merge resolvido, `commitMerge` estagia e so entao procura
  marcador `<<<<<<<`. Checar o indice primeiro reprovaria quem resolveu direito.
  Essa checagem prova ausencia de marcador, **nao** que a juncao ficou correta.

Conflito nunca e resolvido sozinho: o sistema para, emite `worktree.conflict` e
pergunta. So depois de a pessoa autorizar e que um agente e mandado juntar.

## O que ainda nao existe

Personagens, animacoes e pathfinding no 3D. Paralelismo: o gerente monta o
grafo, mas o executor pega sempre a primeira subtask liberada e roda uma de cada
vez. `Assigner`, `BudgetTracker`, `EscalationPolicy` e `GateRunner` continuam so
como tipos. Portoes de verificacao rodando de verdade -- o plano **contem**
`gate`, mas nada roda `test`/`build` na worktree, que alias nasce sem
`node_modules`. Replanejamento automatico depois de subtask que falha
(`Planner.revise` existe e ninguem chama ainda). Autenticacao. Empacotamento
para distribuicao.

`dev.simulate` deixou de ser o unico jeito de ver gerente e contrato -- agora o
modo planejado faz isso com CLI de verdade. O roteiro do simulador continua util
para ver o fluxo inteiro sem gastar chamada de modelo.

## Nota de ambiente (Linux)

O Electron 44 nao tem mais `postinstall` proprio: o binario e baixado pelo script
`postinstall` de `apps/shell` (`install-electron`). Em distros que restringem
user namespaces, o `chrome-sandbox` precisa ser `root:root` com modo 4755:

```
sudo chown root:root node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
```

Sem isso o app aborta na inicializacao -- em algumas maquinas com `FATAL` sobre
o SUID sandbox, em outras com SIGSEGV logo depois da inicializacao do GTK.

`pnpm app:nosandbox` contorna para desenvolver. Desliga o sandbox do Chromium,
entao serve para rodar na propria maquina e nao para virar o caminho padrao.
