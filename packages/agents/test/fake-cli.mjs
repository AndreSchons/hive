#!/usr/bin/env node
/**
 * CLI falsa para testar o ciclo de vida do processo sem gastar API.
 * Cospe as linhas da fixture apontada por OFFICE_FIXTURE e encerra.
 * Ignora os argumentos de proposito: quem esta sob teste e o ClaudeRun.
 */
import { readFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Code)\n');
  process.exit(0);
}

const lines = readFileSync(process.env.OFFICE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim());

/**
 * Segura o processo em pe no modo travado.
 *
 * Sem isto o "travar" nao trava: acabadas as linhas nao sobra timer nenhum, e
 * quando o ClaudeRun fecha o stdin o processo perde o ultimo handle e sai
 * sozinho -- por acidente, e mais rapido do que qualquer teste consegue
 * reagir. O teste de cancelamento virava uma corrida contra isso.
 */
const travado = process.env.OFFICE_HANG === '1' ? setInterval(() => {}, 60_000) : null;

let i = 0;
const tick = () => {
  if (i >= lines.length) {
    if (travado !== null) return; // simula CLI que nao sai sozinha
    process.exit(Number(process.env.OFFICE_EXIT ?? '0'));
  }
  process.stdout.write(`${lines[i++]}\n`);
  setTimeout(tick, 1);
};
process.stdin.resume();
setTimeout(tick, 1);
