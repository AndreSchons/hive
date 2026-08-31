import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentId, gateSchema, newGateId, newTaskId, type Gate, type GateKind } from '@hive/protocol';
import type { Worktree } from '@hive/agents';
import { CommandGateRunner } from '../src/gate-runner';

/**
 * O portao com processo de verdade. Comando falso nao serviria: o que esta sob
 * teste e justamente o que so aparece rodando -- codigo de saida, saida
 * misturada de stdout e stderr, e o comando que nao termina.
 */
let repo: string;
let copia: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-repo-'));
  copia = mkdtempSync(join(tmpdir(), 'gate-copia-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(copia, { recursive: true, force: true });
});

const worktree = (): Worktree => ({
  agentId: agentId.parse('agt_teste_1'),
  repositoryPath: repo,
  path: copia,
  branch: 'hive/agt_teste_1',
  base: 'main',
  createdAt: 0,
});

const gate = (command: string, extra: Partial<Gate> = {}): Gate =>
  gateSchema.parse({ id: newGateId(), kind: 'test' as GateKind, command, ...extra });

const run = (command: string, extra: Partial<Gate> = {}) =>
  new CommandGateRunner({ killGraceMs: 200 }).run({
    gate: gate(command, extra),
    worktree: worktree(),
    taskId: newTaskId(),
  });

describe('o veredito', () => {
  it('aprova quando o comando sai com zero', async () => {
    const result = await run('exit 0');
    expect(result.status).toBe('passed');
  });

  it('reprova com codigo de saida, frase e saida bruta separadas', async () => {
    const result = await run('echo "src/login.ts(3,10): error TS2339: nao existe" >&2; exit 2');
    if (result.status !== 'failed') throw new Error('esperava reprovar');

    expect(result.exitCode).toBe(2);
    // A frase principal e respondivel por quem nao le codigo.
    expect(result.summary).not.toMatch(/TS2339|exit|stderr|stdout/);
    // O detalhe tecnico existe, mas separado.
    expect(result.detail).toContain('TS2339');
  });

  it('conta os problemas apontados em vez de so dizer que falhou', async () => {
    const result = await run('echo "error: um"; echo "error: dois"; exit 1');
    if (result.status !== 'failed') throw new Error('esperava reprovar');
    expect(result.summary).toContain('2 problemas');
  });

  it('junta stderr e stdout: erro de compilador sai pelos dois', async () => {
    const result = await run('echo saida; echo erro >&2; exit 1');
    if (result.status !== 'failed') throw new Error('esperava reprovar');
    expect(result.detail).toContain('saida');
    expect(result.detail).toContain('erro');
  });

  it('comando que nao existe reprova em vez de derrubar a execucao', async () => {
    const result = await run('comando-que-nao-existe-mesmo');
    expect(result.status).toBe('failed');
  });
});

describe('onde e por quanto tempo', () => {
  it('roda dentro da copia do agente, nao no repositorio', async () => {
    writeFileSync(join(copia, 'so-na-copia.txt'), 'oi');
    expect((await run('test -f so-na-copia.txt')).status).toBe('passed');
  });

  it('respeita o cwd relativo declarado no portao', async () => {
    mkdirSync(join(copia, 'apps', 'web'), { recursive: true });
    writeFileSync(join(copia, 'apps', 'web', 'marca.txt'), 'oi');
    const result = await run('test -f marca.txt', { cwd: 'apps/web' });
    expect(result.status).toBe('passed');
  });

  it('para de esperar o comando que nao termina, e diz isso sem jargao', async () => {
    const result = await run('sleep 30', { timeoutMs: 300 });
    if (result.status !== 'timeout') throw new Error('esperava o timeout');
    expect(result.summary).not.toMatch(/SIGKILL|timeout|exit/i);
    expect(result.durationMs).toBeLessThan(10_000);
  });
});
