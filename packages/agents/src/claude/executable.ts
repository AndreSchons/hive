import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Transforma o nome da CLI em algo que `spawn` sem shell consegue abrir.
 *
 * No Linux e no macOS e o proprio nome. No Windows `spawn` so acha `.exe`, e o
 * Claude Code instalado por npm vira um `claude.cmd` -- que o Node recusa sem
 * shell, e com shell os argumentos passariam pelas regras de aspas do cmd.
 * Entao seguimos o shim ate o arquivo que ele chama de verdade.
 */
export function resolveCommand(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  searchPath: string = process.env['PATH'] ?? '',
): Command {
  if (platform !== 'win32') return { file: executable, args: [] };
  // Script sem `.exe` nao roda sozinho no Windows: o shebang nao vale ali.
  if (/\.[cm]?js$/i.test(executable)) return { file: 'node', args: [executable] };
  if (extname(executable) !== '') return { file: executable, args: [] };

  for (const dir of searchPath.split(delimiter)) {
    if (dir === '') continue;
    const exe = join(dir, `${executable}.exe`);
    if (existsSync(exe)) return { file: exe, args: [] };
    const target = shimTarget(join(dir, `${executable}.cmd`));
    if (target !== null) return resolveCommand(target, platform, searchPath);
  }
  // Nao achou: devolve o nome e deixa o `ENOENT` virar a frase de "nao instalado".
  return { file: executable, args: [] };
}

/** O arquivo que um shim `.cmd` do npm chama, ou null se nao for um. */
function shimTarget(shim: string): string | null {
  if (!existsSync(shim)) return null;
  const paths = [...readFileSync(shim, 'utf8').matchAll(/"%dp0%\\([^"]+)"/g)];
  const last = paths.at(-1)?.[1];
  return last === undefined ? null : join(dirname(shim), last);
}
