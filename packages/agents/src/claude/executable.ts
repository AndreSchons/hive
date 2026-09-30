import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Transforma o nome da CLI em algo que `spawn` sem shell consegue abrir.
 *
 * No Linux e no macOS e o caminho do primeiro executavel com esse nome em
 * `unixSearchPath`, ou o proprio nome se nenhum existir. No Windows `spawn` so
 * acha `.exe`, e o Claude Code instalado por npm vira um `claude.cmd` -- que o
 * Node recusa sem shell, e com shell os argumentos passariam pelas regras de
 * aspas do cmd. Entao seguimos o shim ate o arquivo que ele chama de verdade.
 */
export function resolveCommand(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  searchPath: string = platform === 'win32'
    ? windowsSearchPath(process.env)
    : unixSearchPath(process.env),
): Command {
  if (platform !== 'win32') {
    if (executable.includes('/')) return { file: executable, args: [] };
    for (const dir of searchPath.split(delimiter)) {
      if (dir === '') continue;
      const file = join(dir, executable);
      if (isExecutable(file)) return { file, args: [] };
    }
    return { file: executable, args: [] };
  }
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

/**
 * PATH mais os lugares onde os instaladores oficiais poem o Claude Code. O app
 * aberto pelo menu Iniciar herda o PATH do Explorer, que fica velho se a pessoa
 * instalou a CLI depois de entrar no Windows -- e ai o app diria "nao
 * instalado" sobre algo que o terminal dela acha.
 */
export function windowsSearchPath(env: NodeJS.ProcessEnv): string {
  const home = env['USERPROFILE'];
  const appData = env['APPDATA'];
  return [
    env['PATH'] ?? '',
    home === undefined ? '' : join(home, '.local', 'bin'), // instalador nativo
    appData === undefined ? '' : join(appData, 'npm'), // npm install -g
  ].join(delimiter);
}

/**
 * PATH mais os lugares onde os instaladores do Claude Code poem a CLI. O app
 * aberto pelo menu de aplicativos herda o PATH da sessao grafica, que nao passa
 * pelo `.bashrc`: quem instalou a CLI e o terminal acha, o app nao acharia.
 */
export function unixSearchPath(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'];
  return [
    env['PATH'] ?? '',
    home === undefined ? '' : join(home, '.local', 'bin'), // instalador nativo
    home === undefined ? '' : join(home, '.claude', 'local'), // instalador local antigo
    home === undefined ? '' : join(home, '.npm-global', 'bin'), // npm com prefixo no home
    '/usr/local/bin',
  ].join(delimiter);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** O arquivo que um shim `.cmd` do npm chama, ou null se nao for um. */
function shimTarget(shim: string): string | null {
  if (!existsSync(shim)) return null;
  const paths = [...readFileSync(shim, 'utf8').matchAll(/"%dp0%\\([^"]+)"/g)];
  const last = paths.at(-1)?.[1];
  return last === undefined ? null : join(dirname(shim), last);
}
