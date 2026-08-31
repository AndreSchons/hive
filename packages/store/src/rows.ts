import { z } from 'zod';
import {
  SCHEMA_VERSION,
  eventSchema,
  parseEvent,
  type AnyEvent,
  type RunId,
  type RunSummary,
  runSummarySchema,
  projectRefSchema,
  type ProjectRef,
} from '@hive/protocol';

/**
 * Linhas cruas do SQLite. Nada confia no banco: toda leitura passa pelo schema
 * antes de virar tipo do dominio. Um banco corrompido falha aqui, com o run e o
 * seq no erro, e nao tres camadas acima.
 */
export const eventRowSchema = z.object({
  run_id: z.string(),
  seq: z.number().int(),
  event_id: z.string(),
  ts: z.number().int(),
  type: z.string(),
  payload: z.string(),
  schema_version: z.number().int(),
});
export type EventRow = z.infer<typeof eventRowSchema>;

export class CorruptEventError extends Error {
  constructor(
    readonly runId: string,
    readonly seq: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`evento corrompido em ${runId}#${seq}: ${message}`, options);
    this.name = 'CorruptEventError';
  }
}

export function rowToEvent(raw: unknown): AnyEvent {
  const row = eventRowSchema.parse(raw);

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch (error) {
    throw new CorruptEventError(row.run_id, row.seq, 'payload nao e JSON valido', { cause: error });
  }

  const result = eventSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.event_id,
    runId: row.run_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    payload,
  });

  if (!result.success) {
    throw new CorruptEventError(row.run_id, row.seq, z.prettifyError(result.error), { cause: result.error });
  }
  return result.data;
}

export function eventToRow(event: AnyEvent): EventRow {
  return {
    run_id: event.runId,
    seq: event.seq,
    event_id: event.id,
    ts: event.ts,
    type: event.type,
    payload: JSON.stringify(event.payload),
    schema_version: SCHEMA_VERSION,
  };
}

export const runRowSchema = z.object({
  run_id: z.string(),
  project_path: z.string(),
  goal: z.string(),
  status: z.string(),
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  event_count: z.number().int(),
});

export function rowToRunSummary(raw: unknown): RunSummary {
  const row = runRowSchema.parse(raw);
  return runSummarySchema.parse({
    runId: row.run_id,
    projectPath: row.project_path,
    goal: row.goal,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    eventCount: row.event_count,
  });
}

export const projectRowSchema = z.object({
  path: z.string(),
  name: z.string(),
  last_opened_at: z.number().int(),
});

export function rowToProjectRef(raw: unknown, exists: boolean): ProjectRef {
  const row = projectRowSchema.parse(raw);
  return projectRefSchema.parse({
    path: row.path,
    name: row.name,
    lastOpenedAt: row.last_opened_at,
    exists,
  });
}

export type { AnyEvent, RunId };
export { parseEvent };
