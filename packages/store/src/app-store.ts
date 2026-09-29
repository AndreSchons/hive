import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ProjectRef } from '@hive/protocol';
import type { Db } from './db';
import { rowToProjectRef } from './rows';

/**
 * Estado do app que sobrevive entre sessoes e nao pertence a nenhuma execucao.
 * Mora no mesmo SQLite para nao introduzir um segundo formato de persistencia.
 */
export class AppStore {
  constructor(private readonly db: Db) {}

  /** Registra (ou promove) uma pasta na lista de recentes. */
  rememberProject(path: string, at = Date.now()): ProjectRef {
    const full = resolve(path);
    const name = basename(full) || full;
    this.db
      .prepare(
        `INSERT INTO projects (path, name, last_opened_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at, name = excluded.name`,
      )
      .run(full, name, at);
    return { path: full, name, lastOpenedAt: at, exists: existsSync(full) };
  }

  /**
   * Recentes do mais novo para o mais velho. Pastas que sumiram do disco
   * continuam na lista, marcadas com `exists: false`: some-las sem aviso
   * confunde mais do que mostra-las desabilitadas.
   */
  recentProjects(limit = 10): ProjectRef[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects ORDER BY last_opened_at DESC LIMIT ?`)
      .all(limit);
    return rows.map((row) => {
      const parsed = rowToProjectRef(row, true);
      return { ...parsed, exists: existsSync(parsed.path) };
    });
  }

  forgetProject(path: string): boolean {
    const result = this.db.prepare(`DELETE FROM projects WHERE path = ?`).run(resolve(path));
    return result.changes > 0;
  }

  /** A pessoa deixou o app usar esta CLI. Vale ate ela desinstalar o app. */
  allowAdapter(adapter: string, at = Date.now()): void {
    this.db
      .prepare(`INSERT INTO allowed_adapters (adapter, allowed_at) VALUES (?, ?) ON CONFLICT(adapter) DO NOTHING`)
      .run(adapter, at);
  }

  isAdapterAllowed(adapter: string): boolean {
    return this.db.prepare(`SELECT 1 FROM allowed_adapters WHERE adapter = ?`).get(adapter) !== undefined;
  }
}
