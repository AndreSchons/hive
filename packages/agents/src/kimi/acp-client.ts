import type { Readable, Writable } from 'node:stream';
import { LineSplitter, parseLine } from '../process/stream-json';
import { parseFrame } from './acp-messages';

export interface AcpHandlers {
  /** Notificacao do agente: `session/update` e companhia. */
  readonly onNotification: (method: string, params: unknown) => void;
  /**
   * Pedido **do agente para nos**. E por aqui que `session/request_permission`
   * chega, e o agente fica parado ate esta promise resolver.
   */
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
  readonly onClose: (reason?: Error) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const METHOD_NOT_FOUND = -32601;

/**
 * Cliente JSON-RPC 2.0 do Agent Client Protocol, em NDJSON pelos dois sentidos.
 *
 * O que o torna diferente de um cliente comum: as duas pontas fazem pedido. O
 * agente para e nos pergunta se pode usar uma ferramenta, e so continua quando
 * respondemos -- e dai que sai o estado `blocked` de verdade.
 */
export class AcpClient {
  private readonly splitter = new LineSplitter();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly handlers: AcpHandlers,
  ) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      for (const line of this.splitter.push(chunk)) this.receive(line);
    });
    stdout.on('end', () => {
      for (const line of this.splitter.flush()) this.receive(line);
      this.close();
    });
  }

  private receive(raw: string): void {
    const parsed = parseLine(raw);
    if (parsed.kind !== 'json') return;

    const frame = parseFrame(parsed.value);
    if (frame === null) return;

    if (!('method' in frame)) {
      this.settle(frame.id, frame.result, frame.error);
      return;
    }
    if (!('id' in frame)) {
      this.handlers.onNotification(frame.method, frame.params);
      return;
    }
    void this.serve(frame.id, frame.method, frame.params);
  }

  private settle(
    id: number | string,
    result: unknown,
    error: { readonly code: number; readonly message: string } | undefined,
  ): void {
    const key = typeof id === 'number' ? id : Number.parseInt(id, 10);
    const waiting = this.pending.get(key);
    if (waiting === undefined) return;
    this.pending.delete(key);

    if (error !== undefined) waiting.reject(new Error(error.message));
    else waiting.resolve(result);
  }

  private async serve(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      // Recusar um metodo que nao implementamos e resposta normal do protocolo:
      // e assim que o Kimi descobre que nao emprestamos filesystem nem terminal.
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: error instanceof Error ? error.message : `metodo ${method} nao suportado`,
        },
      });
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('a conexao com a CLI ja fechou'));

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params });
  }

  /** Responde um pedido que o agente ainda esta esperando. */
  respond(id: number | string, result: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', id, result });
  }

  private write(frame: unknown): void {
    if (this.stdin.writable) this.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;

    // Ninguem pode ficar esperando para sempre uma resposta que nao vem mais.
    const error = reason ?? new Error('a CLI encerrou antes de responder');
    for (const [, waiting] of this.pending) waiting.reject(error);
    this.pending.clear();
    this.handlers.onClose(reason);
  }
}
