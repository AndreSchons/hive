import { app } from 'electron';
import { join } from 'node:path';

/**
 * O banco fica em userData e nao no repositorio do usuario: o app precisa
 * lembrar de pastas recentes antes de qualquer projeto ser escolhido, e o
 * historico de execucoes nao pertence ao repo que esta sendo trabalhado.
 */
export function databasePath(): string {
  return join(app.getPath('userData'), 'agent-office.sqlite');
}

export function rendererDistPath(): string {
  return join(__dirname, '..', '..', '..', 'hub', 'dist', 'index.html');
}
