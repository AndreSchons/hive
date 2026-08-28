import { describe, expect, it } from 'vitest';
import { AsyncQueue, LineSplitter, parseLine, readStreamJson } from '../src/index';

describe('LineSplitter', () => {
  it('segura a linha parcial entre pedacos', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b')).toEqual(['{"a":1}']);
    expect(splitter.push('":2}\n')).toEqual(['{"b":2}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('entrega a ultima linha quando o processo fecha sem newline', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}')).toEqual([]);
    expect(splitter.flush()).toEqual(['{"a":1}']);
  });

  it('ignora CR de saida vinda de terminal windows', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });
});

describe('parseLine', () => {
  it('classifica JSON valido', () => {
    const line = parseLine('{"type":"x"}');
    expect(line.kind).toBe('json');
    if (line.kind === 'json') expect(line.value).toEqual({ type: 'x' });
  });

  it('classifica aviso em texto puro como malformado, sem lancar', () => {
    expect(parseLine('warning: nova versao disponivel').kind).toBe('malformed');
    expect(parseLine('{ isso nao fecha').kind).toBe('malformed');
    expect(parseLine('').kind).toBe('malformed');
  });
});

describe('readStreamJson', () => {
  async function* chunks(...parts: string[]) {
    for (const part of parts) yield part;
  }

  it('le NDJSON atravessando fronteiras de chunk', async () => {
    const lines = [];
    for await (const line of readStreamJson(chunks('{"n":1}\n{"n"', ':2}\n{"n":3}'))) {
      lines.push(line);
    }
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.kind === 'json')).toBe(true);
  });

  it('nao interrompe o stream por causa de uma linha ruim no meio', async () => {
    const kinds = [];
    for await (const line of readStreamJson(chunks('{"n":1}\naviso da cli\n{"n":2}\n'))) {
      kinds.push(line.kind);
    }
    expect(kinds).toEqual(['json', 'malformed', 'json']);
  });

  it('aceita bytes alem de string', async () => {
    async function* bytes() {
      yield new TextEncoder().encode('{"n":1}\n');
    }
    const lines = [];
    for await (const line of readStreamJson(bytes())) lines.push(line);
    expect(lines[0]?.kind).toBe('json');
  });
});

describe('AsyncQueue', () => {
  /**
   * `push(a, b)` compilava aceitando um argumento so, e o segundo sumia sem
   * erro nenhum. Fila que perde evento em silencio nao serve para transportar
   * o que aconteceu numa execucao.
   */
  it('entrega tudo que foi empurrado de uma vez', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1, 2, 3);
    queue.close();

    const recebidos: number[] = [];
    for await (const value of queue) recebidos.push(value);
    expect(recebidos).toEqual([1, 2, 3]);
  });

  it('entrega tambem para quem ja estava esperando', async () => {
    const queue = new AsyncQueue<number>();
    const recebidos: number[] = [];
    const lendo = (async () => {
      for await (const value of queue) recebidos.push(value);
    })();

    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.push(1, 2);
    queue.close();
    await lendo;

    expect(recebidos).toEqual([1, 2]);
  });
});
