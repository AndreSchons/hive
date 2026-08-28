# Linha de base

O sistema existe para entregar mais rapido e mais barato que rodar a CLI na mao.
Este arquivo guarda o numero que diz se isso e verdade. Sem ele, toda otimizacao
daqui pra frente e fe.

Como refazer a medicao esta no fim.

## 2026-08-28 -- antes de qualquer otimizacao

Tarefa: `trivial` do harness -- *"O botao 'trocar' no topo da barra lateral devia
dizer 'trocar projeto'."* Uma linha de texto, um arquivo.

Repositorio: `agent-office` em `3337882`. Claude Code 2.1.250, modelo padrao.

| | custo | tempo | o que entregou |
| --- | --- | --- | --- |
| `claude -p` direto | **US$ 0,1921** | 9,2 s | **a mudanca feita** |
| Agent Office, so o gerente planejando | **US$ 0,3018** | 23,9 s | um plano de 1 subtask |

O planejamento sozinho custa **57% mais que a CLI cobrou para fazer o trabalho
inteiro** -- e ainda nao mexeu em nada. Depois dele viriam: a sessao fria da
subtask, a instalacao das dependencias na copia e o portao completo.

Consumo da execucao direta, que explica de onde vem o preco:

```
entrada:         8 tokens
saida:         477 tokens
cache escrito: 14.254 tokens
cache lido:    73.150 tokens
```

Praticamente todo o input e cache, e **o cache morre junto com a sessao**. E o
numero que condena dividir trabalho em muitas sessoes curtas: cada subtask nova
paga a criacao do cache de novo, do zero.

## Como refazer

Os dois lados, na mesma tarefa, no mesmo commit:

```sh
# 1. o caminho do sistema (so o gerente, sem executar nada)
pnpm plan-lab -- --task trivial --project .

# 2. a CLI direto, numa copia descartavel para nao sujar o repositorio
git worktree add -b office/baseline /tmp/base-wt HEAD
cd /tmp/base-wt
claude -p 'O botao "trocar" no topo da barra lateral devia dizer "trocar projeto".' \
  --output-format json --permission-mode acceptEdits | jq '.total_cost_usd, .num_turns'
cd -
git worktree remove --force /tmp/base-wt && git branch -D office/baseline
```

A medicao **precisa** rodar na copia: `claude -p` edita arquivo de verdade, e
comparar contra um repositorio sujo mede outra coisa.

## O que mudou desde a primeira medicao

Nenhuma destas mudou o custo de **planejar** -- o gerente continua rodando o
mesmo modelo sobre o mesmo repositorio. O que elas atacam e o custo da execucao
depois do plano, e o relogio.

O custo de instalar varia muito com o que ja esta em cache: 16s na primeira vez
da maquina (o Electron sendo extraido), 1,5s depois disso. A replicacao por
hardlink custa 0,12s nos dois casos, e leva junto o cache de build, que a
instalacao nao tem.

| mudanca | efeito medido |
| --- | --- |
| Instalar uma vez por execucao, replicando por hardlink | 1,5s a 16s -> 0,12s por copia extra |
| Cache de build compartilhado (`TURBO_CACHE_DIR`) | portao completo em 0,95s (cache cheio) / 2s (com mudanca) |
| Escolha de modelo por passo | haiku custa 1/4 de opus no mesmo prompt |

## 2026-08-28 -- a execucao inteira, ponta a ponta

A mesma tarefa, agora com o sistema completo: planejar, aprovar, o agente
trabalhar na copia, o portao, a integracao e o portao do conjunto. Roster
todo-Claude, porque o Kimi nao reporta consumo e deixaria o total incompleto.

| | custo | tempo | entregou |
| --- | --- | --- | --- |
| `claude -p` direto | US$ 0,1921 | 9,2 s | a mudanca feita |
| Agent Office, gerente em **opus** | US$ 0,3337 | 78,0 s | a mudanca feita e integrada |
| Agent Office, gerente em **sonnet** | **US$ 0,1637** | 44,9 s | a mudanca feita e integrada |

Onde o dinheiro foi, na rodada com opus:

```
gerente (opus)        US$ 0,2462   74%
agente (haiku)        US$ 0,0842   25%
overhead interno      US$ 0,0033    1%
```

**O gerente e o custo.** O trabalho em si, feito no degrau economico, custou
US$ 0,084 -- menos da metade dos US$ 0,192 que a CLI cobrou para fazer a mesma
coisa. A execucao ja e mais barata que a CLI; era o planejamento que enterrava
a conta.

Trocando so o modelo do gerente, e mais nada, o sistema **passa a ser mais
barato que a CLI** (US$ 0,164 contra US$ 0,192) e o plano continua correto: um
passo so, no arquivo certo. O gerente ainda e 74% do custo, entao ha mais a
ganhar ali -- e e o `plan-lab` que tem de dizer ate onde da para descer sem o
plano piorar.

Tempo continua pior que a CLI (44,9 s contra 9,2 s), e a conta e transparente:

```
planejar                21,4 s   48%   sessao de modelo que a CLI nao roda
o agente trabalhando    ~12   s   27%   comparavel aos 9,2 s da CLI
primeiro portao          7,6 s   17%   verificacao que a CLI nao fez
instalar a copia         1,5 s    3%
portao do conjunto       1,0 s    2%   a mesma verificacao, agora em cache
git (clone, worktree, merge)  ~1,4 s  3%
```

So um desses e desperdicio de verdade. O agente leva o mesmo tempo que a CLI
levaria, porque e o mesmo trabalho. Os portoes sao servico que a CLI nao
prestou. Sobra **planejar**, que e quase metade do relogio -- e trocar o modelo
do gerente **nao** resolve isso: opus planejou em 19,5 s e sonnet em 21,4 s.
Ficou mais barato, nao mais rapido.

Duas perdas visiveis no log da rodada com opus, que nao aparecem no custo:

- O agente gastou **17 s em dois pedidos de permissao negados**, tentando subir
  o app para conferir visualmente. A politica funcionou, mas ele nao sabia de
  antemao que aquilo seria recusado.
- A mensagem de commit e a descricao inteira da subtask, com paragrafo e tudo.

## 2026-08-28 -- a fila manual, que era o caminho mais caro do sistema

O modo manual ja existia: a pessoa escolhe o papel e manda fazer, sem gerente,
sem plano e sem aprovacao -- mas com portao. Ninguem tinha medido, e a medicao
mostrou o oposto do esperado: **era o caminho mais caro de todos.** Ele nao
tinha como escolher modelo, entao caia no padrao da CLI, que aqui e o opus.

| caminho | custo | tempo | vs `claude -p` |
| --- | --- | --- | --- |
| `claude -p` direto | US$ 0,1921 | 9,2 s | -- |
| **manual, economico (padrao de hoje)** | **US$ 0,0599** | 33,9 s | **3,2x mais barato** |
| manual, economico (outra rodada) | US$ 0,0479 | 25,8 s | 4,0x mais barato |
| planejado, gerente sonnet | US$ 0,1637 | 44,9 s | 1,2x mais barato |
| manual, como era antes (opus por omissao) | US$ 0,2475 | 31,4 s | 1,3x mais **caro** |
| planejado, gerente opus | US$ 0,3337 | 78,0 s | 1,7x mais caro |

Todas as linhas entregaram a mesma mudanca, e todas as do sistema passaram no
portao antes de integrar -- o que a coluna do `claude -p` nao fez.

O sistema agora **bate a CLI em custo** no caminho pequeno, por 3 a 4 vezes, e
continua perdendo em tempo. A conta do tempo esta na secao anterior e nao mudou:
o que sobra depois de tirar o planejamento e o trabalho do agente (comparavel ao
da CLI) mais a verificacao (que a CLI nao faz).

O degrau padrao da fila manual e o economico de proposito: quem escolhe o
proprio papel ja sabe que a tarefa e pequena, e o portao continua valendo, entao
economizar ali nao afrouxa nada. A escolha esta na tela, ao lado do papel.
