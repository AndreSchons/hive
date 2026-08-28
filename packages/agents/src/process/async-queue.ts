/**
 * Fila assincrona de mao unica: o produtor empurra sem esperar, o consumidor
 * itera. Usada para transformar o stdout de um subprocesso (push) no async
 * iterator que `AgentRun` expoe (pull).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: unknown;

  /**
   * Variadico porque e assim que todo mundo chama. Aceitando um argumento so,
   * `push(a, b)` compilava, rodava e **descartava o segundo em silencio** --
   * um evento que some sem erro nenhum e o pior tipo de bug que uma fila pode
   * ter.
   */
  push(...values: readonly T[]): void {
    if (this.closed) return;
    for (const value of values) {
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter({ value, done: false });
        continue;
      }
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.drainWaiters();
  }

  /** Encerra a fila com erro. Quem estiver iterando recebe o throw. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.drainWaiters();
  }

  private drainWaiters(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      if (waiter) waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for (;;) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (result.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      yield result.value;
    }
  }
}
