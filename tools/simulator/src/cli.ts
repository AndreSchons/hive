#!/usr/bin/env node
import { resolve } from 'node:path';
import { EventStore, openDatabase } from '@office/store';
import { runScriptedDemo } from './index';

/**
 * Roda a execucao simulada por fora do app, escrevendo no mesmo banco. E assim
 * que da para ver os eventos chegando na janela sem o orquestrador existir.
 */
function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const withEquals = process.argv.find((arg) => arg.startsWith(prefix));
  if (withEquals !== undefined) return withEquals.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const dbPath = readFlag('db');
  if (dbPath === undefined) {
    console.error(
      [
        'uso: office-simulate --db <caminho.sqlite> [--project <pasta>] [--goal "<texto>"] [--delay <ms>] [--auto-answer <ms>]',
        '',
        'o caminho do banco aparece no hub, no rodape da tela de selecao de pasta.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const projectPath = resolve(readFlag('project') ?? process.cwd());
  const goal = readFlag('goal') ?? 'Adicionar login com email e senha';
  const delay = Number(readFlag('delay') ?? 450);
  const autoAnswerRaw = readFlag('auto-answer');
  const autoAnswerAfterMs = autoAnswerRaw === undefined ? null : Number(autoAnswerRaw);

  const db = openDatabase({ path: resolve(dbPath) });
  const store = new EventStore(db);

  try {
    console.log(`execucao simulada em ${projectPath}`);
    if (autoAnswerAfterMs === null) {
      console.log('vai travar numa pergunta e esperar voce responder na janela do app.');
    }
    const runId = await runScriptedDemo({
      store,
      projectPath,
      goal,
      stepDelayMs: delay,
      autoAnswerAfterMs,
    });
    console.log(`terminou: ${runId}`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error('[simulator]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
