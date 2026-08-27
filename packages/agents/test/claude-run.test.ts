import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetSchema, newAgentId, newTaskId, roleId, type AnyEventDraft } from '@office/protocol';
import { ClaudeAdapter } from '../src/index';

const fakeCli = join(__dirname, 'fake-cli.mjs');
const fixture = (name: string): string => join(__dirname, 'fixtures', name);

function startRun(fixtureName: string, extraEnv: Record<string, string> = {}) {
  const adapter = new ClaudeAdapter({ executable: fakeCli });
  return adapter.start({
    agentId: newAgentId('executor'),
    role: roleId.parse('executor'),
    taskId: newTaskId(),
    cwd: __dirname,
    prompt: 'faca alguma coisa',
    allowedPaths: [],
    contracts: [],
    budget: budgetSchema.parse({}),
    env: { OFFICE_FIXTURE: fixture(fixtureName), ...extraEnv },
  });
}

async function collect(run: AsyncIterable<AnyEventDraft>): Promise<AnyEventDraft[]> {
  const events: AnyEventDraft[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe('ClaudeRun', () => {
  it('descobre a CLI e a versao dela', async () => {
    const probe = await new ClaudeAdapter({ executable: fakeCli }).probe();
    if (!probe.available) throw new Error(`esperava a CLI disponivel: ${probe.reason}`);
    expect(probe.version).toBe('9.9.9');
  });

  it('diz que a CLI nao esta instalada em vez de lancar', async () => {
    const probe = await new ClaudeAdapter({ executable: '/nao/existe/claude' }).probe();
    if (probe.available) throw new Error('esperava a CLI ausente');
    expect(probe.reason.length).toBeGreaterThan(0);
  });

  it('fecha a fila e resolve o desfecho uma vez so', async () => {
    const run = startRun('so-leitura.jsonl');
    const events = await collect(run);

    // O iterador terminou sozinho: sem isso o supervisor ficaria pendurado.
    expect(events.length).toBeGreaterThan(0);
    const outcome = await run.outcome;
    expect(outcome.status).toBe('completed');
    // Pedir o desfecho de novo devolve o mesmo, sem travar.
    expect(await run.outcome).toBe(outcome);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('agent.spawned');
    expect(types[types.length - 1]).toBe('agent.despawned');
  });

  it('encerra sozinho quando a CLI nao sai depois do resultado', async () => {
    // Sem fechar o stdin a CLI fica esperando outro turno para sempre.
    const run = startRun('so-leitura.jsonl', { OFFICE_HANG: '1' });
    const events = await collect(run);
    expect((await run.outcome).status).toBe('completed');
    expect(events.some((event) => event.type === 'agent.despawned')).toBe(true);
  }, 15_000);

  it('trata morte sem resultado como queda, com o codigo de saida', async () => {
    const run = startRun('vazio.jsonl', { OFFICE_EXIT: '3' });
    await collect(run);
    const outcome = await run.outcome;
    if (outcome.status !== 'failed') throw new Error('esperava falha');
    expect(outcome.exitCode).toBe(3);
    // Frase para o usuario, sem jargao.
    expect(outcome.reason).not.toContain('exit');
  });

  it('cancelar encerra a execucao sem virar erro', async () => {
    const run = startRun('so-leitura.jsonl', { OFFICE_HANG: '1' });
    setTimeout(() => run.cancel('Voce pediu para parar.'), 40);
    await collect(run);
    const outcome = await run.outcome;
    expect(outcome.status).toBe('cancelled');
  }, 15_000);
});
