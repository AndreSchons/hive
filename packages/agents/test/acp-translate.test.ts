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
import { AcpTranslator, parseFrame, sessionUpdateSchema } from '../src/index';

/**
 * As fixtures sao frames ACP gravadas do Kimi de verdade. Traduzir contra saida
 * real e o unico jeito de o parser nao virar uma teoria sobre o que a CLI faz.
 */
const PROJETO = '/projeto';

function load(name: string, existentes: readonly string[] = []): AnyEventDraft[] {
  const raw = readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  const translator = new AcpTranslator({
    agentId: newAgentId('frontend'),
    role: roleId.parse('frontend'),
    displayName: 'Kimi',
    adapter: adapterId.parse('kimi'),
    taskId: newTaskId(),
    cwd: PROJETO,
    budget: budgetSchema.parse({}),
    title: 'Tarefa de teste',
    // O disco nao entra no teste: o stream do Kimi nao distingue criar de
    // sobrescrever, entao quem sabe disso e injetado.
    exists: (path) => existentes.includes(path),
  });

  const events = [...translator.start('session_teste', PROJETO)];
  for (const line of raw.split('\n').filter((l) => l.trim().length > 0)) {
    const frame = JSON.parse(line) as { method?: string; params?: { update?: unknown } };
    if (frame.method !== 'session/update') continue;
    const parsed = sessionUpdateSchema.safeParse(frame.params?.update);
    if (parsed.success) events.push(...translator.update(parsed.data));
  }
  events.push(...translator.finish('end_turn', 'Pronto.'));
  return events;
}

const typesOf = (events: readonly AnyEventDraft[]): string[] => events.map((event) => event.type);

/** Estreita pelo `type` em vez de assertar: o compilador continua ajudando. */
function findEvent<T extends AnyEventDraft['type']>(
  events: readonly AnyEventDraft[],
  type: T,
): Extract<AnyEventDraft, { type: T }> | undefined {
  return events.find(
    (event): event is Extract<AnyEventDraft, { type: T }> => event.type === type,
  );
}

describe('sessao que edita um arquivo', () => {
  const events = load('kimi-edita-arquivo.jsonl');

  it('abre o agente e fecha a task', () => {
    expect(typesOf(events)).toContain('agent.spawned');
    expect(typesOf(events)).toContain('task.started');
    expect(typesOf(events)).toContain('task.completed');
  });

  it('sabe que o agente pensou, sem repetir o que ele pensou', () => {
    const pensando = events.find(
      (event) => event.type === 'agent.state_changed' && event.payload.to === 'thinking',
    );
    expect(pensando).toBeDefined();
    // O Kimi manda o pensamento em texto aberto; nao levamos isso para a
    // interface de proposito -- seria ruido para quem nao le codigo.
    if (pensando?.type === 'agent.state_changed') {
      expect(pensando.payload.reason).toBeUndefined();
    }
  });

  it('pareia cada chamada de ferramenta com o resultado dela', () => {
    const chamadas = events.filter((event) => event.type === 'tool.call');
    const resultados = events.filter((event) => event.type === 'tool.result');
    expect(chamadas.length).toBeGreaterThan(0);
    expect(resultados.length).toBe(chamadas.length);

    const ids = new Set(
      chamadas.map((event) => (event.type === 'tool.call' ? event.payload.callId : '')),
    );
    for (const resultado of resultados) {
      if (resultado.type === 'tool.result') expect(ids.has(resultado.payload.callId)).toBe(true);
    }
  });

  /**
   * O detalhe que so a gravacao revela: o bloco de diff chega no update de
   * andamento, nunca no de conclusao. Quem olhasse so o final nao veria nada.
   */
  it('conta as linhas a partir do diff, que chega antes do fim', () => {
    const mudou = findEvent(events, 'file.changed');
    expect(mudou?.payload).toMatchObject({
      path: `${PROJETO}/nota.txt`,
      change: 'modified',
      linesAdded: 1,
      linesRemoved: 1,
    });
  });
});

describe('sessao que cria um arquivo', () => {
  it('reporta criacao quando o arquivo ainda nao existia', () => {
    const mudou = findEvent(load('kimi-cria-arquivo.jsonl'), 'file.changed');
    // No `Write` o Kimi nao manda bloco de diff nenhum: sobra o conteudo cru.
    expect(mudou?.payload).toMatchObject({
      path: `${PROJETO}/saudacao.txt`,
      change: 'created',
      linesAdded: 2,
      linesRemoved: 0,
    });
  });

  it('reporta modificacao quando o arquivo ja estava la', () => {
    const events = load('kimi-cria-arquivo.jsonl', [`${PROJETO}/saudacao.txt`]);
    expect(findEvent(events, 'file.changed')?.payload).toMatchObject({ change: 'modified' });
  });
});

/**
 * As tres formas de frame do JSON-RPC. Existe porque ja quebrou: descrever a
 * resposta como "sem `method`" fazia o Zod exigir a chave, e **toda** resposta
 * era descartada em silencio -- o handshake nunca terminava.
 */
describe('frames do protocolo', () => {
  it('reconhece resposta, notificacao e pedido', () => {
    expect(parseFrame({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })).toMatchObject({
      id: 1,
    });
    expect(parseFrame({ jsonrpc: '2.0', method: 'session/update', params: {} })).toMatchObject({
      method: 'session/update',
    });
    expect(
      parseFrame({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: {} }),
    ).toMatchObject({ id: 9, method: 'session/request_permission' });
  });

  it('devolve nulo em vez de lancar quando a linha nao e frame', () => {
    expect(parseFrame({ oi: 1 })).toBeNull();
  });
});

describe('resumo da task', () => {
  it('conta arquivos, nao chamadas de ferramenta', () => {
    const events = load('kimi-edita-arquivo.jsonl');
    const chamadas = events.filter((event) => event.type === 'tool.call').length;
    const arquivos = new Set(
      events.flatMap((event) => (event.type === 'file.changed' ? [event.payload.path] : [])),
    );

    // A sessao gravada le antes de editar, entao ha mais chamadas que arquivos:
    // e o que separa um numero certo de um numero que parece certo.
    expect(chamadas).toBeGreaterThan(arquivos.size);
    const concluida = events.find((event) => event.type === 'task.completed');
    if (concluida?.type !== 'task.completed') throw new Error('esperava task.completed');
    expect(concluida.payload.filesChanged).toBe(arquivos.size);
  });
});
