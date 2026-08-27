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
let i = 0;
const tick = () => {
  if (i >= lines.length) {
    if (process.env.OFFICE_HANG === '1') return; // simula CLI que nao sai sozinha
    process.exit(Number(process.env.OFFICE_EXIT ?? '0'));
  }
  process.stdout.write(`${lines[i++]}\n`);
  setTimeout(tick, 1);
};
process.stdin.resume();
setTimeout(tick, 1);
