import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetSchema, newAgentId, newTaskId, roleId, type AnyEventDraft } from '@office/protocol';
import { KimiAdapter } from '../src/index';

const fakeCli = join(__dirname, 'fake-acp.mjs');
const fixture = (name: string): string => join(__dirname, 'fixtures', name);

function startRun(env: Record<string, string> = {}) {
  return new KimiAdapter({ executable: fakeCli }).start({
    agentId: newAgentId('frontend'),
    role: roleId.parse('frontend'),
    taskId: newTaskId(),
    cwd: __dirname,
    prompt: 'faca alguma coisa',
    allowedPaths: [],
    contracts: [],
    budget: budgetSchema.parse({}),
    env,
  });
}

async function collect(run: AsyncIterable<AnyEventDraft>): Promise<AnyEventDraft[]> {
  const events: AnyEventDraft[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const typesOf = (events: readonly AnyEventDraft[]): string[] => events.map((event) => event.type);

describe('KimiAdapter', () => {
  it('descobre a CLI e a versao dela', async () => {
    const probe = await new KimiAdapter({ executable: fakeCli }).probe();
    if (!probe.available) throw new Error(`esperava a CLI disponivel: ${probe.reason}`);
    expect(probe.version).toBe('0.0.0');
  });

  it('diz que a CLI nao esta instalada em vez de lancar', async () => {
    const probe = await new KimiAdapter({ executable: '/nao/existe/kimi' }).probe();
    if (probe.available) throw new Error('esperava a CLI ausente');
    expect(probe.reason).toContain('nao esta instalado');
  });
});

describe('KimiRun', () => {
  it('fecha a fila e resolve o desfecho uma vez so', async () => {
    const run = startRun({ OFFICE_FIXTURE: fixture('kimi-edita-arquivo.jsonl') });
    const events = await collect(run);
    const outcome = await run.outcome;

    expect(outcome.status).toBe('completed');
    expect(typesOf(events)).toContain('agent.spawned');
    expect(typesOf(events).at(-1)).toBe('agent.despawned');
    // Pedir o desfecho duas vezes tem que dar a mesma resposta.
    expect(await run.outcome).toBe(outcome);
  });

  /**
   * O caminho que justifica falar ACP em vez do modo `-p`: no modo prompt o
   * Kimi roda em permissao automatica e nunca pararia aqui.
   */
  it('para de verdade esperando o humano, e retoma com a resposta', async () => {
    const run = startRun({ OFFICE_ASK: '1' });
    const events: AnyEventDraft[] = [];
    let perguntou = false;

    for await (const event of run) {
      events.push(event);
      if (event.type === 'human.question_raised' && !perguntou) {
        perguntou = true;
        // O agente esta suspenso agora: so anda depois desta linha.
        run.answer('Pode fazer', 'allow');
      }
    }

    expect(perguntou).toBe(true);
    expect(typesOf(events)).toContain('human.answered');
    expect((await run.outcome).status).toBe('completed');

    const bloqueado = events.find(
      (event) => event.type === 'agent.state_changed' && event.payload.to === 'blocked',
    );
    expect(bloqueado).toBeDefined();
  });

  it('trata queda antes do fim como falha, com o detalhe separado', async () => {
    const run = startRun({ OFFICE_FIXTURE: fixture('vazio.jsonl'), OFFICE_STOP: 'refusal' });
    await collect(run);
    const outcome = await run.outcome;

    if (outcome.status !== 'failed') throw new Error('esperava falha');
    expect(outcome.reason).not.toMatch(/refusal|stopReason/);
  });

  it('cancelar encerra o processo e fecha a execucao', async () => {
    const run = startRun({ OFFICE_ASK: '1' });
    const events: AnyEventDraft[] = [];

    for await (const event of run) {
      events.push(event);
      if (event.type === 'human.question_raised') run.cancel('Voce pediu para parar.');
    }

    expect((await run.outcome).status).toBe('cancelled');
    expect(typesOf(events).at(-1)).toBe('agent.despawned');
  });
});
