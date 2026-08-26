#!/usr/bin/env node
// Espera o servidor do Vite responder e so entao sobe o Electron. Sem isso a
// janela abre antes do renderer existir e mostra uma tela de erro.
import { spawn } from 'node:child_process';

const url = process.env.OFFICE_DEV_SERVER_URL ?? 'http://localhost:5173';
const timeoutMs = 30_000;
const startedAt = Date.now();

async function waitForServer() {
  for (;;) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok || response.status === 404) return;
    } catch {
      // servidor ainda nao subiu
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`o servidor do Vite nao respondeu em ${url} apos ${timeoutMs / 1000}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

try {
  await waitForServer();
} catch (error) {
  console.error(`[dev] ${error.message}`);
  process.exit(1);
}

const electron = spawn(process.platform === 'win32' ? 'electron.cmd' : 'electron', ['.'], {
  stdio: 'inherit',
  env: { ...process.env, OFFICE_DEV_SERVER_URL: url },
  shell: process.platform === 'win32',
});

electron.on('exit', (code) => process.exit(code ?? 0));
