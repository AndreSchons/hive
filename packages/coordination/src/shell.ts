import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/**
 * O shell que roda portao e instalacao: sh em todo lugar.
 *
 * No Windows o padrao do Node seria o `cmd.exe`, e ai `;`, `test -f` e `>&2`
 * -- que aparecem em portao escrito pelo gerente e em script de projeto --
 * mudariam de sentido ou nem rodariam. O Claude Code no Windows ja exige o Git
 * Bash, entao ele esta la; e o mesmo que a CLI usa, pelo mesmo caminho que ela
 * aceita (`CLAUDE_CODE_GIT_BASH_PATH`). Nao achou, cai no `cmd.exe`.
 */
export const SHELL: string | true = process.platform === 'win32' ? (gitBash() ?? true) : true;

function gitBash(): string | null {
  const configured = process.env['CLAUDE_CODE_GIT_BASH_PATH'];
  if (configured !== undefined && existsSync(configured)) return configured;
  // `bash` no PATH pode ser o do WSL (System32), que roda em outro sistema de
  // arquivos. O certo e o que vem junto do `git`: `<Git>/cmd/git.exe` ou
  // `<Git>/mingw64/bin/git.exe`, com o bash em `<Git>/bin/bash.exe`.
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '' || !existsSync(join(dir, 'git.exe'))) continue;
    for (const up of ['..', '../..']) {
      const bash = resolve(dir, up, 'bin', 'bash.exe');
      if (existsSync(bash)) return bash;
    }
  }
  return null;
}

/**
 * Mata o processo e tudo que ele abriu. `pnpm build` vira turbo, que vira um
 * `tsc` por pacote: matar so o shell deixaria todos rodando na maquina de quem
 * esta usando.
 *
 * Fora do Windows o filho nasce `detached`, com grupo proprio, e o pid negativo
 * e o grupo. No Windows nao existe grupo: `taskkill /T` desce a arvore pelo pai
 * de cada processo, e `/F` porque la nao ha sinal educado para mandar antes.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
      'error',
      () => child.kill(signal),
    );
    return;
  }
  try {
    // Negativo e o grupo, nao o processo.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ja morreu entre uma coisa e outra.
    }
  }
}
