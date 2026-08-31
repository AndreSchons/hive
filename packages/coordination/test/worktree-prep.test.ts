import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentId } from '@hive/protocol';
import type { Worktree } from '@hive/agents';
import { InstallWorktreePreparer } from '../src/worktree-prep';
import { installCommand } from '../src/project-context';

/**
 * A copia nasce so com o que esta versionado, e `node_modules` nao esta. Sem
 * preparar, o portao reprovaria toda entrega por falta de dependencia -- e um
 * portao que reprova todo mundo nao verifica nada.
 */
let repo: string;
let copias: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'prep-repo-'));
  copias = mkdtempSync(join(tmpdir(), 'prep-copias-'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'x' } }));
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(copias, { recursive: true, force: true });
});

/** Uma copia vazia, como o git acabou de criar. */
function copia(nome: string): Worktree {
  const path = join(copias, nome);
  mkdirSync(path, { recursive: true });
  return {
    agentId: agentId.parse(`agt_${nome}`),
    repositoryPath: repo,
    path,
    branch: `hive/${nome}`,
    base: 'main',
    createdAt: 0,
  };
}

/**
 * Um instalador falso na frente do PATH: o teste nao pode depender de rede nem
 * do cache de quem esta rodando.
 */
function instalador(corpo: string): { preparer: InstallWorktreePreparer; chamadas: () => number } {
  const bin = join(copias, 'bin');
  mkdirSync(bin, { recursive: true });
  const marca = join(copias, 'chamadas.txt');
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho chamou >> ${marca}\n${corpo}\n`);
  execFileSync('chmod', ['+x', join(bin, 'pnpm')]);

  return {
    preparer: new InstallWorktreePreparer({
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    }),
    chamadas: () =>
      existsSync(marca) ? readFileSync(marca, 'utf8').trim().split('\n').length : 0,
  };
}

/** O que uma instalacao de verdade deixa: pacote, link relativo e cache. */
function popular(path: string): void {
  mkdirSync(join(path, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(path, 'node_modules', 'zod', 'index.js'), 'module.exports = 1;');
  mkdirSync(join(path, 'node_modules', '.cache', 'turbo'), { recursive: true });
  writeFileSync(join(path, 'node_modules', '.cache', 'turbo', 'abc.json'), '{}');
  mkdirSync(join(path, 'packages', 'protocol'), { recursive: true });
  mkdirSync(join(path, 'packages', 'agents', 'node_modules', '@hive'), { recursive: true });
  symlinkSync('../../../protocol', join(path, 'packages', 'agents', 'node_modules', '@hive', 'protocol'));
}

describe('a primeira copia', () => {
  it('instala de verdade', async () => {
    const { preparer, chamadas } = instalador('mkdir -p node_modules');
    const result = await preparer.prepare(copia('um'));

    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.seeded).toBe(false);
    expect(chamadas()).toBe(1);
  });

  it('nao instala quando o agente ja tem as dependencias na copia', async () => {
    const { preparer, chamadas } = instalador('mkdir -p node_modules');
    const alvo = copia('ja-tem');
    mkdirSync(join(alvo.path, 'node_modules'), { recursive: true });

    expect((await preparer.prepare(alvo)).status).toBe('ready');
    expect(chamadas()).toBe(0);
  });

  it('projeto sem package.json nao tem o que instalar', async () => {
    rmSync(join(repo, 'package.json'));
    const { preparer, chamadas } = instalador('exit 1');

    expect((await preparer.prepare(copia('sem-projeto'))).status).toBe('ready');
    expect(chamadas()).toBe(0);
  });

  /**
   * Nao ter conseguido preparar nao e o mesmo que o trabalho estar errado: quem
   * errou nao foi o agente, e a frase precisa dizer isso sem culpar ninguem.
   */
  it('instalacao que falha vira "nao consegui conferir", nao "voce quebrou"', async () => {
    const { preparer } = instalador('echo "ERR_PNPM_NO_LOCKFILE" >&2\nexit 1');
    const result = await preparer.prepare(copia('quebrada'));

    if (result.status !== 'failed') throw new Error(`esperava falhar, veio "${result.status}"`);
    expect(result.summary).toContain('preferi nao integrar nada');
    expect(result.summary).not.toMatch(/pnpm|lockfile|exit/i);
    expect(result.detail).toContain('ERR_PNPM_NO_LOCKFILE');
  });
});

/**
 * O ganho que faz a diferenca entre pagar a instalacao uma vez e paga-la uma
 * vez por subtask. Medido no repositorio de verdade: 16s contra 0,12s.
 *
 * O cache mora fora das copias de proposito: a copia do primeiro agente e
 * apagada assim que o trabalho dele entra no projeto, entao usar a copia
 * anterior como semente funcionaria uma vez e nunca mais.
 */
describe('o cache de dependencias da execucao', () => {
  it('a instalacao deixa uma replica nele', async () => {
    const { preparer } = instalador('mkdir -p node_modules/zod && echo ok > node_modules/zod/index.js');
    const cache = join(copias, 'deps');

    await preparer.prepare(copia('primeira'), cache);
    expect(existsSync(join(cache, 'node_modules', 'zod', 'index.js'))).toBe(true);
  });

  it('a copia seguinte sai dele, sem instalar de novo', async () => {
    const { preparer, chamadas } = instalador('exit 1');
    const cache = join(copias, 'deps');
    mkdirSync(cache, { recursive: true });
    popular(cache);

    const result = await preparer.prepare(copia('segunda'), cache);
    if (result.status !== 'ready') throw new Error('esperava ficar pronta');
    expect(result.seeded).toBe(true);
    // O instalador nem foi chamado -- e ele falharia se fosse.
    expect(chamadas()).toBe(0);
  });

  it('replica por hardlink: o arquivo e o mesmo, nao uma copia', async () => {
    const { preparer } = instalador('exit 1');
    const cache = join(copias, 'deps');
    mkdirSync(cache, { recursive: true });
    popular(cache);
    const segunda = copia('segunda');
    await preparer.prepare(segunda, cache);

    const origem = statSync(join(cache, 'node_modules', 'zod', 'index.js'));
    const destino = statSync(join(segunda.path, 'node_modules', 'zod', 'index.js'));
    expect(destino.ino).toBe(origem.ino);
  });

  /**
   * A propriedade que faz isso ser correto e nao so rapido. Os links de pacote
   * do workspace sao relativos, entao na copia nova eles apontam para os fontes
   * **daquela** copia. Se virassem caminho absoluto, o portao leria a versao
   * antiga do vizinho e ficaria verde sobre codigo que nem existe mais.
   */
  it('preserva symlink como symlink, e ele continua relativo', async () => {
    const { preparer } = instalador('exit 1');
    const cache = join(copias, 'deps');
    mkdirSync(cache, { recursive: true });
    popular(cache);
    const segunda = copia('segunda');
    await preparer.prepare(segunda, cache);

    const link = join(segunda.path, 'packages', 'agents', 'node_modules', '@hive', 'protocol');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../../../protocol');
  });

  it('leva o cache de build junto: a copia nova nasce com o build aproveitado', async () => {
    const { preparer } = instalador('exit 1');
    const cache = join(copias, 'deps');
    mkdirSync(cache, { recursive: true });
    popular(cache);
    const segunda = copia('segunda');
    await preparer.prepare(segunda, cache);

    expect(existsSync(join(segunda.path, 'node_modules', '.cache', 'turbo', 'abc.json'))).toBe(true);
  });

  it('cache vazio cai na instalacao, em vez de parar a execucao', async () => {
    const { preparer, chamadas } = instalador('mkdir -p node_modules');
    const result = await preparer.prepare(copia('segunda'), join(copias, 'nunca-existiu'));

    expect(result.status).toBe('ready');
    expect(chamadas()).toBe(1);
  });
});

describe('como instalar', () => {
  /**
   * Um portao de verificacao nao decide dependencia do projeto. Todos os
   * comandos travam a versao -- e o caso sem lockfile ainda evita criar um,
   * porque `package-lock.json` novo viraria commit no projeto da pessoa.
   */
  it('nunca deixa a instalacao mexer no que o projeto resolveu', () => {
    expect(installCommand(repo)).toBe('pnpm install --frozen-lockfile --prefer-offline');

    rmSync(join(repo, 'pnpm-lock.yaml'));
    expect(installCommand(repo)).toBe('npm install --no-package-lock');
  });

  it('projeto sem package.json nao tem o que instalar', () => {
    rmSync(join(repo, 'package.json'));
    expect(installCommand(repo)).toBeNull();
  });
});
