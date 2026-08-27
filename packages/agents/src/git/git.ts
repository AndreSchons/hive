import { execFile } from 'node:child_process';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Roda o `git` e devolve o que aconteceu. **Nunca lanca por codigo de saida**:
 * merge que conflita sai com codigo 1, e isso e uma resposta do dominio, nao um
 * erro de programa. Quem chama decide o que cada codigo significa.
 */
export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // Sem executavel, sem permissao, sem pasta: ai sim e falha de verdade.
        if (error !== null && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error === null ? 0 : error.code as number, stdout, stderr });
      },
    );
  });
}

/** Igual, mas o codigo diferente de zero vira excecao com a saida de erro junto. */
export async function gitOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} falhou (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export const lines = (output: string): string[] =>
  output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
