import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adapterId,
  budgetSchema,
  newAgentId,
  newTaskId,
  roleId,
  type AnyEventDraft,
} from '@office/protocol';
import { parseCliLine, StreamTranslator } from '../src/index';

/**
 * As fixtures sao NDJSON gravado da CLI de verdade. Traduzir contra saida real
 * e o unico jeito de o parser nao virar uma teoria sobre o que a CLI faz.
 */
function load(name: string): { events: AnyEventDraft[]; translator: StreamTranslator } {
  const raw = readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  const lines = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => parseCliLine(JSON.parse(line) as unknown))
    .filter((line): line is NonNullable<typeof line> => line !== null);

  // A pasta vem da propria fixture: o teste nao depende de onde ela foi gravada.
  const init = lines.find((line) => line.type === 'system' && line.subtype === 'init');
  const cwd = init !== undefined && init.type === 'system' && init.subtype === 'init' ? (init.cwd ?? '.') : '.';

  const taskId = newTaskId();
  const translator = new StreamTranslator({
    agentId: newAgentId('backend'),
    role: roleId.parse('backend'),
    displayName: 'Claude Code',
    adapter: adapterId.parse('claude'),
    taskId,
    cwd,
    budget: budgetSchema.parse({}),
    title: 'Tarefa de teste',
  });

  return { events: lines.flatMap((line) => translator.line(line)), translator };
}

const typesOf = (events: readonly AnyEventDraft[]): string[] => events.map((event) => event.type);

/** Estreita pelo `type` em vez de assertar: o compilador continua ajudando. */
function findEvent<T extends AnyEventDraft['type']>(
  events: readonly AnyEventDraft[],
  type: T,
): Extract<AnyEventDraft, { type: T }> {
  const found = events.find(
    (event): event is Extract<AnyEventDraft, { type: T }> => event.type === type,
  );
  if (found === undefined) throw new Error(`esperava um evento ${type}`);
  return found;
}

describe('StreamTranslator', () => {
  it('abre a execucao com o agente e a sessao da CLI', () => {
    const { events, translator } = load('so-leitura.jsonl');

    const spawned = findEvent(events, 'agent.spawned').payload;
    expect(spawned.adapter).toBe('claude');
    // A sessao e a chave para retomar esta mesma conversa depois.
    expect(spawned.sessionId).toBeDefined();
    // Sem worktree nesta etapa: melhor ausente do que um nome inventado.
    expect(spawned.branch).toBeUndefined();
    expect(translator.session).toBe(spawned.sessionId);

    expect(typesOf(events)).toContain('task.started');
  });

  it('mostra que o agente pensou, mesmo sem poder dizer o que ele pensou', () => {
    const { events } = load('so-leitura.jsonl');
    const states = events.filter((event) => event.type === 'agent.state_changed');
    expect(states.some((event) => event.payload.to === 'thinking')).toBe(true);
    expect(states.some((event) => event.payload.to === 'working')).toBe(true);
    expect(states[states.length - 1]?.payload.to).toBe('done');
  });

  it('pareia cada chamada de ferramenta com o resultado dela', () => {
    const { events } = load('so-leitura.jsonl');
    const calls = events.filter((event) => event.type === 'tool.call');
    const results = events.filter((event) => event.type === 'tool.result');

    expect(calls.length).toBeGreaterThan(0);
    expect(results.length).toBe(calls.length);
    for (const call of calls) {
      expect(results.some((result) => result.payload.callId === call.payload.callId)).toBe(true);
    }
    expect(results.every((result) => result.payload.ok)).toBe(true);
  });

  it('conta as linhas de uma edicao e de um arquivo novo', () => {
    const { events } = load('edita-arquivo.jsonl');
    const changes = events.filter((event) => event.type === 'file.changed');

    const edited = changes.find((event) => event.payload.change === 'modified');
    expect(edited?.payload.path).toBe('alvo.txt');
    expect(edited?.payload.linesAdded).toBe(1);
    expect(edited?.payload.linesRemoved).toBe(1);

    // Arquivo criado vem com patch vazio: contar hunks daria zero linhas.
    const created = changes.find((event) => event.payload.change === 'created');
    expect(created?.payload.path).toBe('novo.txt');
    expect(created?.payload.linesAdded).toBeGreaterThan(0);
  });

  it('marca como falha a ferramenta que foi recusada', () => {
    const { events } = load('permissao-negada.jsonl');
    const failed = events.filter((event) => event.type === 'tool.result' && !event.payload.ok);

    expect(failed.length).toBe(1);
    const recusada = failed[0];
    if (recusada === undefined || recusada.type !== 'tool.result') {
      throw new Error('esperava um tool.result recusado');
    }
    expect(recusada.payload.tool).toBe('Write');
    // A saida crua fica em `detail`, nunca na frase principal.
    expect(recusada.payload.detail).toContain('Nao autorizado');
    expect(recusada.payload.summary).not.toContain('Nao autorizado');
  });

  it('nao inventa evento para a linha de pedido de permissao', () => {
    // Quem decide permissao e a execucao, nao a traducao.
    const { events } = load('pergunta-ao-humano.jsonl');
    expect(typesOf(events)).not.toContain('human.question_raised');
  });

  it('fecha a task com o texto final do agente', () => {
    const { events } = load('so-leitura.jsonl');
    const completed = findEvent(events, 'task.completed').payload;
    expect(completed.summary.length).toBeGreaterThan(0);
    expect(completed.summary.length).toBeLessThanOrEqual(280);
  });

  it('repassa a fala do agente como mensagem para o humano', () => {
    const { events } = load('so-leitura.jsonl');
    const message = findEvent(events, 'agent.message').payload;
    expect(message.to).toBe('human');
    expect(message.summary.length).toBeLessThanOrEqual(280);
  });
});
