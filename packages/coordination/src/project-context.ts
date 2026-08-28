import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateKind } from '@office/protocol';

/**
 * Descobre os comandos de verificacao que o projeto realmente tem.
 *
 * Existe para o gerente nao inventar portao. Um plano cujo portao e
 * `npm run check` num projeto que so tem `pnpm typecheck` parece valido, passa
 * no schema, e so quebra na hora de verificar -- que e tarde.
 */
export interface AvailableGate {
  readonly kind: GateKind;
  readonly command: string;
}

/** Nome do script -> tipo de portao. O resto vira `custom`. */
const KNOWN: readonly (readonly [string, GateKind])[] = [
  ['typecheck', 'typecheck'],
  ['tsc', 'typecheck'],
  ['build', 'build'],
  ['test', 'test'],
  ['lint', 'lint'],
];

export function discoverGates(projectPath: string): AvailableGate[] {
  const scripts = readScripts(projectPath);
  const runner = detectRunner(projectPath);
  const gates: AvailableGate[] = [];

  for (const name of Object.keys(scripts)) {
    const known = KNOWN.find(([script]) => script === name);
    gates.push({ kind: known?.[1] ?? 'custom', command: `${runner} ${name}` });
  }
  return gates;
}

function readScripts(projectPath: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null || !('scripts' in raw)) return {};
    const { scripts } = raw as { scripts?: unknown };
    if (typeof scripts !== 'object' || scripts === null) return {};
    return Object.fromEntries(
      Object.entries(scripts as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    // Projeto sem `package.json`, ou com um quebrado: sem portao conhecido e
    // resposta valida. O gerente e avisado de que nao encontrou nenhum.
    return {};
  }
}

/** Qual gerenciador roda os scripts, pelo lockfile que estiver no disco. */
function detectRunner(projectPath: string): string {
  const locks: readonly (readonly [string, string])[] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun run'],
    ['package-lock.json', 'npm run'],
  ];
  for (const [file, runner] of locks) {
    try {
      readFileSync(join(projectPath, file));
      return runner;
    } catch {
      continue;
    }
  }
  return 'npm run';
}
