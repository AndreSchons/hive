import { z } from 'zod';
import {
  SCHEMA_VERSION,
  eventDraftSchema,
  newEventId,
  newRunId,
  type AnyEvent,
  type AnyEventDraft,
  type RunId,
  type RunSummary,
} from '@office/protocol';
import type { Db } from './db';
import { describe } from './db';
import { rowToEvent, rowToRunSummary } from './rows';

export interface CreateRunInput {
  readonly projectPath: string;
  readonly goal: string;
  /** Permite ao chamador fixar o id (o simulador precisa disso). */
  readonly runId?: RunId;
  readonly startedAt?: number;
}

export type RunStatus = RunSummary['status'];

/** Draft recusado antes de tocar o disco. Carrega a posicao dentro do lote. */
export class InvalidEventError extends Error {
  constructor(readonly index: number, detail: string, options?: { cause?: unknown }) {
    super(`evento invalido na posicao ${index} do lote: ${detail}`, options);
    this.name = 'InvalidEventError';
  }
}

/**
 * Log append-only de eventos. `seq` e por execucao, comeca em 1 e nao tem
 * buracos: o mundo 3D reproduz uma execucao inteira so lendo daqui em ordem.
 */
export class EventStore {
  constructor(private readonly db: Db) {}

  createRun(input: CreateRunInput): RunId {
    const runId = input.runId ?? newRunId();
    this.db
      .prepare(
        `INSERT INTO runs (run_id, project_path, goal, status, started_at, ended_at)
         VALUES (?, ?, ?, 'running', ?, NULL)`,
      )
      .run(runId, input.projectPath, input.goal, input.startedAt ?? Date.now());
    return runId;
  }

  finishRun(runId: RunId, status: Exclude<RunStatus, 'running'>, endedAt = Date.now()): void {
    const result = this.db
      .prepare(`UPDATE runs SET status = ?, ended_at = ? WHERE run_id = ?`)
      .run(status, endedAt, runId);
    if (result.changes === 0) {
      throw new Error(`execucao desconhecida: ${runId}`);
    }
  }

  hasRun(runId: RunId): boolean {
    return this.db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(runId) !== undefined;
  }

  getRun(runId: RunId): RunSummary | null {
    const row = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.run_id = r.run_id) AS event_count
         FROM runs r WHERE r.run_id = ?`,
      )
      .get(runId);
    return row === undefined ? null : rowToRunSummary(row);
  }

  listRuns(projectPath: string, limit = 50): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.run_id = r.run_id) AS event_count
         FROM runs r WHERE r.project_path = ? ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(projectPath, limit);
    return rows.map(rowToRunSummary);
  }

  /** Ultimo seq gravado da execucao. 0 quando ainda nao ha evento. */
  lastSeq(runId: RunId): number {
    const value: unknown = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?`)
      .pluck()
      .get(runId);
    return typeof value === 'number' ? value : 0;
  }

  /**
   * Grava um evento. A alocacao do seq e o INSERT acontecem na mesma transacao
   * IMMEDIATE: dois processos escrevendo na mesma execucao nao produzem seq
   * duplicado nem buraco.
   */
  append(runId: RunId, event: AnyEventDraft, at = Date.now()): AnyEvent {
    const [sealed] = this.appendMany(runId, [event], at);
    if (sealed === undefined) {
      throw new Error('append nao devolveu evento');
    }
    return sealed;
  }

  appendMany(runId: RunId, events: readonly AnyEventDraft[], at = Date.now()): AnyEvent[] {
    if (events.length === 0) return [];

    // O store e a fronteira de durabilidade: o que entra aqui fica gravado para
    // sempre e vai ser lido no replay meses depois. Draft vindo de adaptador ou
    // do IPC nao passou necessariamente por `draft()`, entao valida de novo.
    const validated = events.map((event, index) => {
      const result = eventDraftSchema.safeParse(event);
      if (!result.success) {
        throw new InvalidEventError(index, z.prettifyError(result.error), { cause: result.error });
      }
      return result.data;
    });

    const insert = this.db.prepare(
      `INSERT INTO events (run_id, seq, event_id, ts, type, payload, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const write = this.db.transaction((drafts: readonly AnyEventDraft[]): AnyEvent[] => {
      if (!this.hasRun(runId)) {
        throw new Error(`execucao desconhecida: ${runId}`);
      }

      let seq = this.lastSeq(runId);
      const sealed: AnyEvent[] = [];

      for (const item of drafts) {
        seq += 1;
        const id = newEventId();
        insert.run(runId, seq, id, at, item.type, JSON.stringify(item.payload), SCHEMA_VERSION);
        sealed.push({ schemaVersion: SCHEMA_VERSION, id, runId, seq, ts: at, ...item });
      }
      return sealed;
    });

    try {
      return write.immediate(validated);
    } catch (error) {
      throw new Error(`falha ao gravar ${validated.length} evento(s) em ${runId}: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  /** Eventos da execucao com seq maior que `afterSeq`, em ordem. */
  read(runId: RunId, afterSeq = 0, limit = 5000): AnyEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(runId, afterSeq, limit);
    return rows.map(rowToEvent);
  }

  /**
   * Replay completo, em lotes, sem carregar a execucao inteira na memoria.
   * E este metodo que permite ao mundo 3D reencenar uma execucao sem agente.
   */
  *replay(runId: RunId, batchSize = 500): Generator<AnyEvent, void, undefined> {
    let cursor = 0;
    for (;;) {
      const batch = this.read(runId, cursor, batchSize);
      if (batch.length === 0) return;
      for (const event of batch) {
        yield event;
      }
      const last = batch[batch.length - 1];
      if (last === undefined) return;
      cursor = last.seq;
    }
  }

  /** Eventos recentes de qualquer execucao do projeto. Usado para o feed inicial. */
  latestRunOf(projectPath: string): RunSummary | null {
    return this.listRuns(projectPath, 1)[0] ?? null;
  }
}
