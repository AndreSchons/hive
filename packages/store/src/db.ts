import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type Db = Database.Database;

/**
 * Schema do banco local. Migracoes sao aplicadas em ordem e a posicao fica em
 * `PRAGMA user_version`, entao abrir um banco antigo e sempre seguro.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    run_id       TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    goal         TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER
  );

  CREATE INDEX runs_by_project ON runs (project_path, started_at DESC);

  -- Log append-only. Nada aqui e atualizado ou apagado.
  CREATE TABLE events (
    global_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    event_id       TEXT NOT NULL UNIQUE,
    ts             INTEGER NOT NULL,
    type           TEXT NOT NULL,
    payload        TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    UNIQUE (run_id, seq)
  );

  CREATE INDEX events_by_run ON events (run_id, seq);

  CREATE TABLE projects (
    path           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    last_opened_at INTEGER NOT NULL
  );
  `,
];

/** Impede escrita fora do append: SQLite recusa UPDATE e DELETE em `events`. */
const APPEND_ONLY_GUARDS = `
  CREATE TRIGGER IF NOT EXISTS events_are_immutable
  BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events e append-only: UPDATE recusado'); END;

  CREATE TRIGGER IF NOT EXISTS events_are_permanent
  BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events e append-only: DELETE recusado'); END;
`;

export interface OpenOptions {
  /** Caminho do arquivo, ou ':memory:' nos testes. */
  readonly path: string;
  readonly readonly?: boolean;
}

export function openDatabase({ path, readonly = false }: OpenOptions): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { readonly });

  // WAL deixa leitor e escritor conviverem: o processo principal le enquanto
  // o simulador (ou o orquestrador) escreve.
  if (!readonly) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  if (!readonly) {
    migrate(db);
  }
  return db;
}

export function migrate(db: Db): void {
  const applied = readUserVersion(db);
  if (applied >= MIGRATIONS.length) return;

  for (let version = applied; version < MIGRATIONS.length; version += 1) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(statement);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`falha na migracao ${version + 1}: ${describe(error)}`, { cause: error });
    }
  }
  db.exec(APPEND_ONLY_GUARDS);
}

function readUserVersion(db: Db): number {
  const value: unknown = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
