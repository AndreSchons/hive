# Agent Office -- instrucoes para agentes

App desktop que orquestra a CLI de agente ja instalada no terminal do usuario
(Claude Code) trabalhando no mesmo repositorio, com a execucao visualizada como
um escritorio 3D isometrico. Varios agentes ao mesmo tempo, uma CLI so.

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

## Se voce esta trabalhando em `apps/hub`

E o unico lugar do repositorio com React e Three.js, e o mais tentador de
estragar. Antes de escrever:

- Voce pode importar `@office/protocol`. **Nada mais do workspace.** Precisou de
  um dado que nao existe? Ele entra no protocol como campo de evento, e o
  produtor daquele evento passa a preenche-lo. Nao busque o dado por outro
  caminho.
- `src/world/` recebe estado ja reduzido. Nao le evento cru, nao chama IPC, nao
  conhece agente, CLI nem modelo. Um componente 3D que precise saber qual CLI
  rodou e sinal de que o estado do mundo esta faltando um campo.
- `src/state/event-reducer.ts` e puro e total: mesmo log, mesma ordem, mesmo
  mundo. Sem `Date.now()`, sem `Math.random()`, sem I/O. E o que permite
  reencenar uma execucao gravada.
- `src/state/describe.ts` e o unico lugar que decide texto de evento. Detalhe
  tecnico vai em `detail`, nunca no corpo da frase.
- O `switch` do redutor e exaustivo por tipo de evento. Tipo novo no protocol
  quebra a compilacao aqui de proposito -- trate, nao adicione `default`.
- `pnpm dev` com `?demo` na URL mostra o escritorio cheio no navegador, sem
  Electron nem ponte: `src/demo.ts` semeia a store com o roteiro do simulador
  (so em dev; no build de producao some). E o caminho para revisao visual.
  Somar `&pensando` deixa o gerente em `thinking` no fim do roteiro, que e como
  se ve a nuvem de pensamento sem esperar uma execucao de verdade.
- O angulo da camera mora em `src/world/camera.ts`, nao na `Scene`. Adorno que
  precisa cair sempre no mesmo ponto da tela (a nuvem de pensamento) sai de
  `billboardAnchor`: deslocar na direcao da camera nao move nada na projecao
  ortografica, e o adorno acaba em cima da cabeca.
- O vite resolve `@office/protocol` e `@office/simulator` pelos fontes TS
  (`resolve.alias`): os dists sao CJS e o interop nao enxerga os nomes
  re-exportados. Os tipos continuam vindo dos `.d.ts`.

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
pnpm app         # abre o app com o hub ja compilado
pnpm app:nosandbox   # idem, sem o sandbox do Chromium (ver nota de Linux)
pnpm --filter @office/simulator start -- --db <caminho> --project <pasta>
pnpm plan-lab -- --task all --project .   # so o gerente, sem executar nada
```

## Se voce esta mexendo em custo, portao ou escalonamento

O sistema existe para sair mais barato que rodar a CLI na mao, e
`tools/planner-lab/BASELINE.md` guarda o numero que diz se isso e verdade. Leia
antes de otimizar qualquer coisa, e refaca a medicao depois.

- **`agent.usage` sai um por modelo**, nunca um total: uma execucao mistura
  modelos, e o total sozinho nao diz qual modelo vale para qual passo. CLI que
  nao reporta consumo **nao emite** -- zero se leria como "de graca".
- **Preparar a copia e do `WorktreePreparer`, nao do portao**, e acontece antes
  de o agente comecar. Instala uma vez por execucao e replica por hardlink
  (`cp -al`) nas seguintes: 16s contra 0,12s. Symlink do `node_modules` do
  projeto foi tentado e nao serve -- o pnpm recusa pasta de modulos fora da
  raiz, e num monorepo o portao leria a versao antiga dos pacotes vizinhos.
- **O portao de subtask nunca ve a juncao.** `verifyIntegrated` roda os portoes
  do plano no repositorio ja integrado antes de declarar entregue: dois passos
  podem passar sozinhos e quebrar juntos.
- **Modelo e decisao de quem paga.** `DefaultModelPolicy` recomenda um degrau
  por passo a partir do que o plano ja declara; a pessoa escolhe a postura no
  aval do plano. `modelTier` fica fora de `subtaskDraftSchema` pela mesma razao
  que `budget` fica.

Tres regras do produto viram codigo aqui, e cada uma tem um lugar so:

- **Nenhum agente aprova o proprio trabalho.** `CommandGateRunner` roda um
  comando do proprio projeto na copia do agente, por fora dele, e codigo de
  saida e o unico criterio. Preparacao que falha **para** a execucao em vez de
  culpar o agente: quem errou nao foi ele, e nao ha o que ele conserte.
- **Escalonar e decidir entre tres coisas.** `DefaultEscalationPolicy` e o unico
  lugar que escolhe entre tentar de novo, perguntar e desistir -- e o unico que
  escreve texto de parada, tanto a frase da pessoa quanto a instrucao do agente.
  Portao vermelho ganha **uma** segunda chance com o erro colado no pedido; a
  duvida do proprio agente nunca vira nova tentativa, sobe como ele escreveu.
- **Limite e por subtask, nao por tentativa.** `budget.start` uma vez, cada
  tentativa recebe `budget.remaining()`. Um teto que se renova a cada tentativa
  nao e teto.

## O que ainda nao existe

Pathfinding no 3D (o movimento dos personagens segue caminhos em L sobre o
layout fixo do escritorio). Animacoes proprias para `talking` e `blocked` (hoje
caem no `idle`). Paralelismo: o gerente monta o grafo, mas o executor roda uma
subtask de cada vez, e `Assigner` continua so como tipo. Replanejamento
automatico depois de subtask que falha. Mais de um portao por subtask
(`Subtask.gate` e um so). Autenticacao. Empacotamento para distribuicao.

O roteiro do simulador (`dev.simulate`) continua util para ver o fluxo inteiro
sem gastar chamada de modelo.

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
`pnpm app:nosandbox` contorna para desenvolver, mas desliga o sandbox do
Chromium e nao deve virar o caminho padrao.
