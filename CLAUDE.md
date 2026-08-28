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

## Quanto custa, e por que isso vem antes de tudo

O sistema existe para entregar mais rapido e mais barato que rodar a CLI na mao.
`tools/planner-lab/BASELINE.md` guarda o numero que diz se isso e verdade -- e
na primeira medicao **nao era**: so planejar uma troca de rotulo de botao custou
US$ 0,30, contra US$ 0,19 que a CLI cobrou para fazer o trabalho inteiro.

Nada se otimiza sem esse numero, entao ele e evento de primeira classe.

- **`agent.usage` sai um por modelo**, nao um total. Uma unica execucao da CLI
  mistura modelos (ela usa um barato para trabalho interno dela), e o total
  sozinho nao responde a unica pergunta que interessa: qual modelo vale para
  qual passo. Vem de `modelUsage` na linha `result`, que as fixtures gravadas ja
  traziam.
- **CLI que nao reporta consumo nao emite nada.** Zero se leria como "foi de
  graca", e essa e a unica coisa que este numero nao pode dizer. O ACP do Kimi
  nao reporta, entao execucao de Kimi aparece sem custo -- ausente, nao zerada.
- **`cacheCreationTokens` e `cacheReadTokens` vivem separados** porque e a
  diferenca entre eles que explica o preco: naquela fixture, 6.744 tokens
  escritos no cache contra 28.295 lidos, com 6 de input novo. Praticamente todo
  o input e cache, e **o cache morre junto com a sessao** -- e o argumento
  numerico contra dividir trabalho em muitas sessoes curtas.
- O gasto do **gerente conta**. `RunSupervisor.track` e o unico caminho de
  escrita no log, e o planejamento passa por ele como qualquer agente: deixa-lo
  de fora faria o total mentir para menos justamente no passo que roda sempre.
- `pnpm plan-lab` imprime custo por task e o total da rodada. E o loop de
  realimentacao mais barato do repositorio: dez planejamentos dizem se uma
  mudanca de prompt ficou mais cara.

## Como uma entrega e aceita

Um agente dizer "terminei" nao termina nada. Entre o desfecho da CLI e o merge
existe um portao: um comando do proprio projeto, rodado por fora, na copia do
agente, com codigo de saida como unico criterio. `CommandGateRunner`
(`packages/coordination/src/gate-runner.ts`) e quem roda.

- **Preparar a copia nao e trabalho do portao** -- e do `WorktreePreparer`, e
  acontece **antes de o agente comecar**, nao antes de verificar. Assim o
  proprio agente consegue rodar a verificacao enquanto trabalha.
- **Instala uma vez por execucao, nao uma por subtask.** A primeira copia paga a
  instalacao de verdade (16s medidos aqui, com o cache do gerenciador quente) e
  deixa uma replica em `<worktrees>/<runId>/deps`; as seguintes saem dela por
  `cp -al` -- **0,12s para 600 MB**. O cache mora fora das copias porque a copia
  do primeiro agente e apagada assim que o trabalho dele entra no projeto: usar
  a copia anterior como semente funcionaria uma vez e nunca mais.
- **Hardlink e nao symlink, e isso importa duas vezes.** Ligar o `node_modules`
  do projeto por symlink foi tentado e nao serve: o pnpm recusa uma pasta de
  modulos que resolve para fora da raiz (`ERR_PNPM_UNSAFE_MODULES_DIR`), e, num
  monorepo, os links dos pacotes vizinhos apontariam para o repositorio
  original -- o portao leria a versao **antiga** do vizinho e ficaria verde
  sobre codigo que nem existe mais. Com hardlink os arquivos ficam fisicamente
  dentro da copia, e os links de workspace do pnpm, que sao **relativos**
  (`../../../protocol`), passam a apontar para os fontes daquela copia. A
  correcao vem de graca junto com a velocidade.
- **`TURBO_CACHE_DIR` aponta para a pasta da execucao**, entao a segunda subtask
  so recompila o que a primeira mexeu. Isso nao afrouxa o portao: o turbo indexa
  por hash do conteudo, e arquivo mexido invalida a entrada -- conferido
  introduzindo um erro de tipo numa copia semeada, que reprovou normalmente.
- **Toda instalacao trava a versao** (`--frozen-lockfile`, `npm ci`), e o caso
  sem lockfile usa `--no-package-lock`: um `package-lock.json` criado por uma
  verificacao viraria commit no projeto da pessoa -- decisao de projeto tomada
  por um portao.
- **Nao ter conseguido preparar nao e reprovar.** `PrepareResult.failed` **para
  a execucao** em vez de virar pedido de correcao: quem errou nao foi o agente,
  e nao ha o que ele conserte. `GateFailure` so contem o que da para cobrar
  dele, entao o tipo impede culpar o agente por problema de ambiente.
- **O timeout mata o grupo, nao o processo.** `pnpm build` vira turbo, que vira
  um `tsc` por pacote; matar so o shell deixaria todos rodando na maquina de
  quem esta usando. E o veredito sai depois do prazo mesmo que `close` nunca
  chegue: um processo morto continua segurando a saida enquanto algum filho
  tiver o descritor aberto, e um portao nao pode pendurar a execucao inteira
  esperando um comando que ele mesmo mandou parar.
- **`commitAll` nunca estagia `node_modules`**, mesmo que o projeto nao o
  ignore. A preparacao instala dependencia dentro da copia, e a exclusao nao
  pode depender do `.gitignore` de quem esta usando o app.
- A fila que a pessoa monta na mao nao passa por plano e nao traz portao
  declarado, entao `defaultGate` escolhe um dos comandos do proprio projeto
  (`typecheck` > `build` > `test` > `lint`, do sinal mais barato para o mais
  caro). Sem isso a fila manual seria o unico caminho do sistema em que
  "terminei" e aceito sem ninguem conferir.

### O portao do conjunto

O portao de cada subtask roda na copia daquele agente, sobre o trabalho daquele
agente. **Nenhum deles ve o resultado da juncao** -- e e exatamente ai que mora
a quebra que ninguem previu: dois passos que passam sozinhos e nao passam
juntos, porque cada copia saiu do mesmo ponto de partida e nao conhecia o
trabalho do outro.

Por isso `verifyIntegrated` roda os portoes do plano **no repositorio ja
integrado**, antes de declarar entregue. Reprovou, a frase diz que o trabalho
**ja esta no projeto**: nesse ponto nao ha o que desfazer sozinho, e o que a
pessoa precisa decidir e se reverte ou se conserta.

Estreitar o comando do portao ao que a subtask tocou (`--filter` por pacote) foi
considerado e **nao entrou**: com o cache compartilhado, um `pnpm typecheck`
completo na copia semeada custa 0,95s em cache cheio e 2s quando ha mudanca, e
estreitar economizaria cerca de um segundo em troca de cirurgia de string
especifica por ferramenta -- e de um filtro que nao casa com nada **sair com
zero**, que e portao verde falso. O cache resolveu o problema que o estreitamento
resolveria.

### Tentar de novo, perguntar, ou desistir

`DefaultEscalationPolicy` (`packages/coordination/src/escalation.ts`) e o unico
lugar que decide isso, e o unico lugar que escreve texto de parada -- tanto a
frase que a pessoa le quanto a instrucao que o agente recebe.

**Portao vermelho ganha uma segunda chance, e so uma.** A primeira falha vira
pedido de correcao com a saida do comando colada no prompt; a segunda vira
pergunta. E a mesma conta que o gerente ja faz quando o JSON do plano nao
valida, e pela mesma razao: o erro que o modelo conserta sozinho ele conserta na
segunda tentativa, e a terceira so repete a segunda.

Duas frases do pedido de correcao nao podem sair dali: **nao apague nem
desative teste, verificacao ou regra**, e **nao mude o objetivo da tarefa**. Sem
elas o caminho mais curto para o portao ficar verde e apagar o teste que
reprovou -- e ai o portao para de significar qualquer coisa.

A duvida do proprio agente (`agent_asked`) **nunca** vira nova tentativa: sobe
com as palavras dele, porque quem sabe o que falta e ele, e chutar aqui entrega
a coisa errada. A resposta volta para a **mesma conversa** (`sessionId`), nao
para um agente novo sem contexto -- e a diferenca entre `onAnswer: 'session'` e
`'restart'` na decisao.

O orcamento vale pela **subtask inteira**, nao por tentativa: `runOne` chama
`budget.start` uma vez, o supervisor conta cada `tool.call` que passa pelo log,
e cada tentativa recebe `budget.remaining()`. Sem isso "trinta turnos" viraria
trinta por tentativa, que nao e teto nenhum. Quando a pessoa responde "pode
continuar" depois de um estouro, o teto volta a valer do zero -- foi ela quem
assumiu.

Acima de tudo isso ha `ATTEMPT_CEILING`, que so existe para "tentar de novo"
respondido muitas vezes seguidas nao virar laco infinito.

### Qual modelo cada passo usa

O sistema recomenda, a pessoa decide. A escolha entra no **aval do plano**, que
ja e uma parada obrigatoria: uma pergunta so para escolher modelo seria uma
interrupcao a mais por uma decisao que cabe nesta.

`DefaultModelPolicy` (`packages/coordination/src/model-policy.ts`) recomenda um
degrau por subtask a partir de sinais que o plano **ja declara** -- quantas
areas toca, se tem contrato de entrada, quantos passos dependem dela -- e nunca
de opiniao do modelo sobre o proprio trabalho. E a mesma regra que ja vale para
orcamento, pela mesma razao: quem paga a conta e quem decide. Por isso
`modelTier` e `modelReason` saem de `subtaskDraftSchema` e entram em
`withSystemFields`, ao lado de `gate.id` e `budget`.

A ordem das regras vai do risco maior para o menor: um passo do qual outros
dependem erra caro, porque o erro dele viaja para todos os que vem depois.

O aval oferece tres formas de comecar -- economico, como sugerido, caprichado --
e a postura desloca a escada inteira um degrau, sem obrigar ninguem a escolher
passo a passo. `modelReason` e escrito para quem nao le codigo ("mexe numa area
so"), porque e ele que aparece na tela: "sonnet" nao diz nada para essa pessoa.

Quem resolve degrau -> alias e o **papel**, que e quem conhece a CLI
(`RoleDefinition.models`). Papel sem escada roda no modelo padrao da CLI e a
postura simplesmente nao o afeta -- e o caso do Kimi, cujos aliases saem do
`config.toml` de cada usuario: mandar um nome que a CLI nao conhece derruba a
execucao inteira, e um padrao honesto vale mais que um alias chutado.

Medido com o mesmo prompt trivial no Claude Code: haiku US$ 0,0165, sonnet
US$ 0,0408, opus US$ 0,0680. A escada e real, e e por isso que a escolha importa.

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
vez, e `Assigner` continua so como tipo. Replanejamento automatico depois de
subtask que falha (`Planner.revise` existe e ninguem chama ainda). Autenticacao.
Empacotamento para distribuicao.

O portao roda uma verificacao por subtask, a que o plano declarou -- rodar
`typecheck` **e** `test` na mesma entrega precisaria de uma lista no schema, e
hoje `Subtask.gate` e um so.

O que ainda **falta para o sistema ficar mais barato que a CLI**, na ordem em
que vale, esta medido em `tools/planner-lab/BASELINE.md`:

1. **Brief do projeto injetado em cada subtask.** E o maior corte de tokens que
   sobra. A fixture mostra que quase todo o input e cache e que o cache morre
   com a sessao; um resumo da estrutura e das convencoes, produzido uma vez pelo
   gerente e passado num `AgentRunRequest.context` novo, evita N reexploracoes
   do mesmo repositorio. Tem risco proprio: um brief errado contamina todas as
   subtasks de uma vez.
2. **Paralelismo**, que transforma soma em caminho critico.
3. **Subir de modelo quando o portao reprova**, em vez de repetir o mesmo --
   encaixa direto em `EscalationDecision.retry`.

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
