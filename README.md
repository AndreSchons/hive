# Agent Office

Orquestra as CLIs de agente instaladas no seu terminal trabalhando juntas no
mesmo repositorio, com a execucao visualizada como um escritorio 3D isometrico.

## Rodando

```
pnpm install
pnpm build
pnpm app
```

Escolha uma pasta de projeto, escreva uma task e a execucao simulada roda o fluxo
inteiro -- plano, contrato, trabalho em paralelo, verificacao, e uma pergunta que
para tudo ate voce responder.

Para disparar a execucao simulada pelo terminal, contra o mesmo banco:

```
pnpm --filter @office/simulator start -- \
  --db ~/.config/agent-office/agent-office.sqlite \
  --project /caminho/do/projeto
```

Com o app aberto naquela pasta, os eventos aparecem na janela sozinhos.

A arquitetura e as regras de fronteira estao em [CLAUDE.md](./CLAUDE.md).
