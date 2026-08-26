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
```

## O que ainda nao existe

Personagens, animacoes e pathfinding no 3D. Adaptadores reais de CLI (a interface
esta desenhada para eles, so ha `MockAdapter`). Implementacoes de `coordination`
(so os tipos). Prompts de agente. Autenticacao. Empacotamento para distribuicao.

`run.start` recusa explicitamente com uma frase para o usuario ate o orquestrador
existir. Use a execucao simulada (`dev.simulate`) para ver o fluxo inteiro.

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
