import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Worktree } from '@hive/agents';
import { installCommand } from './project-context';

export type PrepareResult =
  | {
      readonly status: 'ready';
      /** Veio de outra copia desta execucao, em vez de uma instalacao nova. */
      readonly seeded: boolean;
      readonly durationMs: number;
    }
  | {
      /**
       * A copia nao ficou em condicao de ser usada -- dependencia que nao
       * instalou, quase sempre. Nao e o mesmo que o trabalho estar errado: quem
       * errou nao foi o agente, e nao ha o que ele conserte.
       */
      readonly status: 'failed';
      readonly command: string;
      readonly summary: string;
      readonly detail: string;
      readonly durationMs: number;
    };

/**
 * Deixa a copia do agente em condicao de rodar o projeto.
 *
 * A worktree nasce so com o que esta versionado, e `node_modules` nao esta. Sem
 * isto o portao reprovaria toda entrega por falta de dependencia -- e um portao
 * que reprova todo mundo nao verifica nada.
 */
export interface WorktreePreparer {
  /**
   * `cache` e uma pasta da execucao onde as dependencias ficam guardadas. A
   * primeira copia instala e deixa uma replica ali; as seguintes saem dela.
   *
   * O cache existe porque a copia do primeiro agente **e apagada** assim que o
   * trabalho dele entra no projeto -- usar a copia anterior como semente
   * funcionaria uma vez e nunca mais.
   */
  prepare(worktree: Worktree, cache?: string): Promise<PrepareResult>;
}

export interface InstallWorktreePreparerOptions {
  /** Desligado, nada e instalado. Serve para projeto sem dependencia nenhuma. */
  readonly install?: boolean;
  readonly timeoutMs?: number;
  readonly maxDetailChars?: number;
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_DETAIL_CHARS = 8_000;

/**
 * Instala uma vez por execucao e replica por hardlink nas copias seguintes.
 *
 * A primeira copia paga a instalacao de verdade (medido neste repositorio: 16s
 * com o cache do gerenciador quente). As seguintes recebem os mesmos arquivos
 * por hardlink, que custou **0,12s para 600 MB** -- a diferenca entre pagar a
 * instalacao uma vez e paga-la uma vez por subtask.
 *
 * Duas coisas fazem isso funcionar, e nenhuma das duas e obvia:
 *
 * - Os links de pacote do workspace que o pnpm cria sao **relativos**
 *   (`../../../protocol`), entao dentro da copia nova eles apontam para os
 *   fontes **daquela** copia. Fossem absolutos, o portao leria a versao antiga
 *   do pacote vizinho e ficaria verde sobre codigo que nem existe mais.
 * - O cache do turbo mora em `node_modules/.cache` e viaja junto, entao a copia
 *   nova ja nasce com o build anterior aproveitado. Isso **nao** afrouxa o
 *   portao: o turbo indexa por hash do conteudo, e arquivo mexido invalida a
 *   entrada (conferido -- um erro de tipo introduzido na copia semeada reprovou
 *   normalmente).
 */
export class InstallWorktreePreparer implements WorktreePreparer {
  constructor(private readonly options: InstallWorktreePreparerOptions = {}) {}

  async prepare(worktree: Worktree, cache?: string): Promise<PrepareResult> {
    const started = Date.now();
    const done = (seeded: boolean): PrepareResult => ({
      status: 'ready',
      seeded,
      durationMs: Date.now() - started,
    });

    if (this.options.install === false) return done(false);
    // O agente pode ter instalado por conta propria; nesse caso a copia manda.
    if (existsSync(join(worktree.path, 'node_modules'))) return done(false);

    const command = installCommand(worktree.repositoryPath);
    // Projeto sem `package.json` nao tem o que instalar, e o portao dele
    // provavelmente nem depende disso.
    if (command === null) return done(false);

    if (cache !== undefined && (await this.replicate(cache, worktree.path))) return done(true);

    const result = await run(
      command,
      worktree.path,
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      this.options.env,
    );
    if (result.code === 0) {
      // Guarda para as proximas copias. Hardlink nao duplica byte nenhum, entao
      // o cache nao custa disco -- custa entradas de diretorio.
      if (cache !== undefined) await this.replicate(worktree.path, cache);
      return done(false);
    }

    return {
      status: 'failed',
      command,
      summary:
        'Nao consegui preparar a copia do projeto para conferir o trabalho, entao preferi nao integrar nada.',
      detail: tail(result.output, this.options.maxDetailChars ?? DEFAULT_DETAIL_CHARS),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Replica as dependencias por hardlink. Devolve falso quando nao deu -- e ai
   * o caminho normal de instalar assume, em vez de a execucao parar.
   */
  private async replicate(from: string, to: string): Promise<boolean> {
    // `cp -al` nao existe no Windows, e refazer isso em Node arquivo a arquivo
    // seria mais lento que a propria instalacao.
    if (process.platform === 'win32') return false;

    const found = nodeModulesIn(from);
    if (found.length === 0) return false;

    for (const relative of found) {
      const target = join(to, relative);
      if (existsSync(target)) continue;
      try {
        await mkdir(dirname(target), { recursive: true });
      } catch {
        return false;
      }
      // `-a` preserva symlink como symlink (e nao o conteudo apontado), que e o
      // que mantem os links relativos do pnpm funcionando na copia nova.
      const result = await run(
        `cp -al ${quote(join(from, relative))} ${quote(target)}`,
        to,
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        this.options.env,
      );
      if (result.code !== 0) return false;
    }
    return true;
  }
}

/** Aspas simples do shell, com escape do que fecharia a aspa. */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Todo `node_modules` do projeto, sem descer dentro deles. */
function nodeModulesIn(root: string, depth = 4): string[] {
  const found: string[] = [];

  const walk = (directory: string, relative: string, left: number): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') {
        found.push(join(relative, entry.name));
        continue;
      }
      if (entry.name.startsWith('.') || left === 0) continue;
      walk(join(directory, entry.name), join(relative, entry.name), left - 1);
    }
  };

  walk(root, '', depth);
  return found;
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Readonly<Record<string, string>> | undefined,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    });

    let output = '';
    let settled = false;
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };

    const timer = setTimeout(() => {
      const { pid } = child;
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      settle(-1);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error: Error) => {
      output += `\n${error.message}`;
      settle(-1);
    });
    child.on('close', (code) => settle(code ?? -1));
  });
}

function tail(output: string, max: number): string {
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  return `[...saida cortada...]\n${trimmed.slice(trimmed.length - max)}`;
}
