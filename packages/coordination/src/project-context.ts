import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateSchema, newGateId, type Gate, type GateKind } from '@office/protocol';

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

/**
 * Gerenciador de pacotes do projeto, pelo lockfile que estiver no disco.
 * `run` e o prefixo que executa um script; `install` traz as dependencias de
 * volta numa copia recem-criada, sem tocar no lockfile.
 */
interface PackageManager {
  readonly run: string;
  readonly install: string;
}

const MANAGERS: readonly (readonly [string, PackageManager])[] = [
  // Todos com trava: a copia instala exatamente o que o projeto ja resolveu.
  // Um portao que atualiza dependencia por conta propria reprovaria (ou
  // aprovaria) por um motivo que nao tem nada a ver com o que o agente fez.
  ['pnpm-lock.yaml', { run: 'pnpm', install: 'pnpm install --frozen-lockfile --prefer-offline' }],
  ['yarn.lock', { run: 'yarn', install: 'yarn install --frozen-lockfile' }],
  ['bun.lockb', { run: 'bun run', install: 'bun install --frozen-lockfile' }],
  ['package-lock.json', { run: 'npm run', install: 'npm ci --prefer-offline' }],
];

/**
 * Sem lockfile nao ha o que travar, e `--no-package-lock` nao e detalhe: um
 * `npm install` comum criaria `package-lock.json` dentro da copia, e esse
 * arquivo viraria commit no projeto de quem esta usando o app -- uma decisao
 * de projeto tomada por um portao de verificacao.
 */
const NPM_SEM_TRAVA: PackageManager = {
  run: 'npm run',
  install: 'npm install --no-package-lock',
};

function detectManager(projectPath: string): PackageManager {
  for (const [file, manager] of MANAGERS) {
    try {
      readFileSync(join(projectPath, file));
      return manager;
    } catch {
      continue;
    }
  }
  return NPM_SEM_TRAVA;
}

const detectRunner = (projectPath: string): string => detectManager(projectPath).run;

/**
 * Como trazer as dependencias para uma copia recem-criada. `null` quando o
 * projeto nao tem `package.json`: ai nao ha o que instalar, e tentar instalar
 * seria pior que nao fazer nada.
 */
export function installCommand(projectPath: string): string | null {
  try {
    readFileSync(join(projectPath, 'package.json'));
  } catch {
    return null;
  }
  return detectManager(projectPath).install;
}

/**
 * Um portao para quem nao declarou nenhum -- a fila que a pessoa monta na mao
 * nao passa por plano, e sem isto seria o unico caminho do sistema onde
 * "terminei" e aceito sem ninguem conferir.
 *
 * A ordem e do sinal mais barato para o mais caro: conferir tipo custa
 * segundos e ja pega codigo quebrado; rodar a suite inteira custa minutos e
 * so entra quando o projeto nao oferece nada mais rapido.
 */
const GATE_PRIORITY: readonly GateKind[] = ['typecheck', 'build', 'test', 'lint'];

export function defaultGate(projectPath: string): Gate | undefined {
  const available = discoverGates(projectPath);
  for (const kind of GATE_PRIORITY) {
    const found = available.find((gate) => gate.kind === kind);
    if (found !== undefined) {
      return gateSchema.parse({ id: newGateId(), kind: found.kind, command: found.command });
    }
  }
  return undefined;
}
