#!/usr/bin/env node
/**
 * Servidor ACP falso para testar o ciclo de vida do processo sem gastar API.
 * Fala o mesmo JSON-RPC que o `kimi acp`, replica as frames de uma fixture e
 * -- quando pedido -- suspende esperando permissao, que e o caminho que mais
 * importa cobrir. Quem esta sob teste e o KimiRun.
 */
import { readFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0 (Fake Kimi)\n');
  process.exit(0);
}

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (update) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session_falsa', update } });

const frames = process.env.OFFICE_FIXTURE
  ? readFileSync(process.env.OFFICE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim())
  : [];

let buffer = '';
let promptId = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function finishPrompt() {
  send({
    jsonrpc: '2.0',
    id: promptId,
    result: { stopReason: process.env.OFFICE_STOP ?? 'end_turn' },
  });
  if (process.env.OFFICE_HANG !== '1') process.exit(0);
}

function handle(frame) {
  if (frame.method === 'initialize') {
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (frame.method === 'session/new') {
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'session_falsa' } });
    return;
  }
  if (frame.method === 'session/cancel') {
    if (promptId !== null) send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    process.exit(0);
  }
  if (frame.method === 'session/prompt') {
    promptId = frame.id;
    for (const raw of frames) {
      const parsed = JSON.parse(raw);
      if (parsed.method === 'session/update') notify(parsed.params.update);
    }
    if (process.env.OFFICE_ASK === '1') {
      // Suspende: daqui em diante nada acontece ate a resposta chegar.
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'session/request_permission',
        params: {
          sessionId: 'session_falsa',
          options: [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: 'call_perm',
            title: 'Bash',
            rawInput: { command: 'rm -rf /' },
          },
        },
      });
      return;
    }
    finishPrompt();
    return;
  }
  // Resposta nossa a um pedido dele: e a permissao chegando de volta.
  if (frame.id === 9001) {
    process.stdout.write('');
    process.stderr.write(`PERMISSION:${JSON.stringify(frame.result)}\n`);
    finishPrompt();
  }
}
