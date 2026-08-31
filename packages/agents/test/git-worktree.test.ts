import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newAgentId, type AgentId } from '@hive/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorktreeManager, branchFor } from '../src/index';
import type { Worktree } from '../src/index';

/**
 * Git de verdade num repositorio temporario, sem mock nenhum. E o unico jeito
 * de provar que o caminho de conflito funciona: conflito de merge nao se
 * simula, e um `git` falso concordaria com qualquer coisa que escrevessemos.
 */
const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

let repo: string;
let homes: string;
const manager = new GitWorktreeManager();

const ARQUIVO = 'src/login.txt';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'hive-repo-'));
  homes = mkdtempSync(join(tmpdir(), 'hive-wt-'));

  run(repo, 'init', '--initial-branch=main');
  run(repo, 'config', 'user.name', 'Teste');
  run(repo, 'config', 'user.email', 'teste@hive.local');
  execFileSync('mkdir', ['-p', join(repo, 'src')]);
  writeFileSync(join(repo, ARQUIVO), 'linha um\nlinha dois\nlinha tres\n');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-m', 'inicio');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(homes, { recursive: true, force: true });
});

const criar = async (nome: string): Promise<{ agent: AgentId; worktree: Worktree }> => {
  const agent = newAgentId(nome);
  const worktree = await manager.create({
    agentId: agent,
    repositoryPath: repo,
    base: 'main',
    branch: branchFor(agent),
    path: join(homes, agent),
  });
  return { agent, worktree };
};

/** Reescreve a segunda linha: dois agentes fazendo isso colidem no mesmo hunk. */
const editarSegundaLinha = (worktree: Worktree, texto: string): void => {
  writeFileSync(join(worktree.path, ARQUIVO), `linha um\n${texto}\nlinha tres\n`);
};

describe('check', () => {
  it('recusa pasta que nao e repositorio', async () => {
    const solta = mkdtempSync(join(tmpdir(), 'hive-solta-'));
    const resultado = await manager.check(solta);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toContain('repositorio git');
    rmSync(solta, { recursive: true, force: true });
  });

  it('recusa arvore suja, para o trabalho da pessoa nao se misturar', async () => {
    writeFileSync(join(repo, ARQUIVO), 'mudanca que a pessoa fez e nao salvou\n');
    const resultado = await manager.check(repo);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toContain('nao salvas');
  });

  it('aceita repositorio limpo e fixa o ponto de partida', async () => {
    const resultado = await manager.check(repo);
    expect(resultado).toMatchObject({ ok: true, branch: 'main' });
    // O commit e fixado aqui de proposito: toda copia da execucao sai dele, e
    // nao da ponta do branch, que anda a cada integracao.
    if (resultado.ok) expect(resultado.commit).toBe(run(repo, 'rev-parse', 'HEAD').trim());
  });
});

describe('isolamento', () => {
  it('da a cada agente uma copia propria, e nunca a mesma pasta', async () => {
    const a = await criar('alfa');
    const b = await criar('beta');

    expect(a.worktree.path).not.toBe(b.worktree.path);
    expect(readFileSync(join(a.worktree.path, ARQUIVO), 'utf8')).toContain('linha dois');

    // O que um escreve nao aparece para o outro: e isso que "isolado" quer dizer.
    editarSegundaLinha(a.worktree, 'so o alfa ve isto');
    expect(readFileSync(join(b.worktree.path, ARQUIVO), 'utf8')).toContain('linha dois');

    const registradas = await manager.list(repo);
    expect(registradas.map((w) => w.agentId).sort()).toEqual([a.agent, b.agent].sort());
  });

  it('nao commita nada quando o agente nao mudou nada', async () => {
    const { worktree } = await criar('parado');
    expect(await manager.commitAll(worktree, 'nada')).toBe(false);
  });

  /**
   * A verificacao instala dependencia dentro da copia. Num projeto sem
   * `.gitignore` isso viraria commit no repositorio de quem esta usando o app,
   * entao a exclusao nao pode depender da configuracao do projeto.
   */
  /**
   * O caso comum, e o que quebrou de verdade: quase todo projeto ignora
   * `node_modules`. Um `add` com pathspec explicito recusa arquivo ignorado
   * ("use -f if you really want to add them") e derrubava a entrega inteira.
   */
  it('commita normalmente num projeto que ignora node_modules', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-m', 'ignora dependencia');

    const { worktree } = await criar('com-gitignore');
    execFileSync('mkdir', ['-p', join(worktree.path, 'node_modules', 'zod')]);
    writeFileSync(join(worktree.path, 'node_modules', 'zod', 'index.js'), '');
    editarSegundaLinha(worktree, 'mudou');

    expect(await manager.commitAll(worktree, 'trabalho')).toBe(true);
    expect(run(worktree.path, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(ARQUIVO);
  });

  it('nunca commita node_modules, mesmo sem o projeto ignorar', async () => {
    const { worktree } = await criar('instalou');
    execFileSync('mkdir', ['-p', join(worktree.path, 'node_modules', 'zod')]);
    execFileSync('mkdir', ['-p', join(worktree.path, 'apps', 'web', 'node_modules', 'react')]);
    writeFileSync(join(worktree.path, 'node_modules', 'zod', 'index.js'), '');
    writeFileSync(join(worktree.path, 'apps', 'web', 'node_modules', 'react', 'index.js'), '');

    // Dependencia sozinha nao e trabalho entregue: nao ha o que commitar.
    expect(await manager.commitAll(worktree, 'so dependencia')).toBe(false);

    editarSegundaLinha(worktree, 'mudou');
    expect(await manager.commitAll(worktree, 'trabalho')).toBe(true);
    expect(run(worktree.path, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(ARQUIVO);
  });

  it('conta o que mudou na copia', async () => {
    const { worktree } = await criar('conta');
    editarSegundaLinha(worktree, 'mudou');
    await manager.commitAll(worktree, 'mudanca');

    const diff = await manager.diff(worktree);
    expect(diff.commits).toBe(1);
    expect(diff.files).toEqual([{ path: ARQUIVO, added: 1, removed: 1 }]);
  });
});

describe('merge', () => {
  it('integra a copia quando ninguem mais mexeu', async () => {
    const { worktree } = await criar('sozinho');
    editarSegundaLinha(worktree, 'trabalho do agente');
    await manager.commitAll(worktree, 'trabalho');

    expect(await manager.merge(worktree, 'main')).toEqual({ status: 'merged', filesChanged: 1 });
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).toContain('trabalho do agente');
  });

  it('responde vazio quando nao ha nada para integrar', async () => {
    const { worktree } = await criar('vazio');
    expect(await manager.merge(worktree, 'main')).toEqual({ status: 'empty' });
  });

  it('remove a copia e apaga o branch quando o trabalho e descartado', async () => {
    const { worktree } = await criar('descartado');
    editarSegundaLinha(worktree, 'nao vai entrar');
    await manager.commitAll(worktree, 'trabalho');

    await manager.remove(worktree);
    expect(await manager.list(repo)).toEqual([]);
    expect(run(repo, 'branch', '--list', worktree.branch).trim()).toBe('');
  });
});

/**
 * O cenario que esta etapa existe para cobrir: dois agentes editando o mesmo
 * arquivo de proposito. O primeiro entra limpo; o segundo tem que parar.
 */
describe('dois agentes no mesmo arquivo', () => {
  it('detecta o conflito, para, e deixa o merge em curso para ser resolvido', async () => {
    const alfa = await criar('alfa');
    const beta = await criar('beta');

    editarSegundaLinha(alfa.worktree, 'o alfa escreveu aqui');
    await manager.commitAll(alfa.worktree, 'trabalho do alfa');
    editarSegundaLinha(beta.worktree, 'o beta escreveu outra coisa');
    await manager.commitAll(beta.worktree, 'trabalho do beta');

    expect(await manager.merge(alfa.worktree, 'main')).toEqual({ status: 'merged', filesChanged: 1 });

    const segundo = await manager.merge(beta.worktree, 'main');
    expect(segundo).toEqual({ status: 'conflict', files: [ARQUIVO] });

    // Parou de verdade: o merge continua em curso, com os dois lados no arquivo.
    expect(await manager.conflictFiles(repo)).toEqual([ARQUIVO]);
    const conflitado = readFileSync(join(repo, ARQUIVO), 'utf8');
    expect(conflitado).toContain('<<<<<<<');
    expect(conflitado).toContain('o alfa escreveu aqui');
    expect(conflitado).toContain('o beta escreveu outra coisa');
  });

  /**
   * Protege a decisao de fixar o ponto de partida no comeco da execucao. Se as
   * copias forem cortadas da ponta do branch, que anda a cada integracao, o
   * segundo agente ja parte do trabalho do primeiro e conflito nenhum acontece
   * -- o caminho de conflito inteiro viraria codigo morto.
   */
  it('nao conflita quando a segunda copia sai do trabalho ja integrado', async () => {
    const alfa = await criar('alfa');
    editarSegundaLinha(alfa.worktree, 'o alfa escreveu aqui');
    await manager.commitAll(alfa.worktree, 'trabalho do alfa');
    await manager.merge(alfa.worktree, 'main');

    // Cortada depois da integracao: ela ja contem o que o alfa fez.
    const beta = newAgentId('beta');
    const tardia = await manager.create({
      agentId: beta,
      repositoryPath: repo,
      base: 'main',
      branch: branchFor(beta),
      path: join(homes, beta),
    });
    editarSegundaLinha(tardia, 'o beta escreveu outra coisa');
    await manager.commitAll(tardia, 'trabalho do beta');

    expect(await manager.merge(tardia, 'main')).toEqual({ status: 'merged', filesChanged: 1 });
  });

  it('parar por aqui devolve o repositorio exatamente como estava', async () => {
    const alfa = await criar('alfa');
    const beta = await criar('beta');
    editarSegundaLinha(alfa.worktree, 'alfa');
    await manager.commitAll(alfa.worktree, 'alfa');
    editarSegundaLinha(beta.worktree, 'beta');
    await manager.commitAll(beta.worktree, 'beta');
    await manager.merge(alfa.worktree, 'main');

    const antes = run(repo, 'rev-parse', 'HEAD').trim();
    await manager.merge(beta.worktree, 'main');
    await manager.abortMerge(repo);

    expect(run(repo, 'rev-parse', 'HEAD').trim()).toBe(antes);
    expect(run(repo, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(repo, ARQUIVO), 'utf8')).not.toContain('<<<<<<<');
  });

  it('recusa fechar o merge enquanto sobrar marcador de conflito', async () => {
    const alfa = await criar('alfa');
    const beta = await criar('beta');
    editarSegundaLinha(alfa.worktree, 'alfa');
    await manager.commitAll(alfa.worktree, 'alfa');
    editarSegundaLinha(beta.worktree, 'beta');
    await manager.commitAll(beta.worktree, 'beta');
    await manager.merge(alfa.worktree, 'main');
    await manager.merge(beta.worktree, 'main');

    // Um agente que dissesse "terminei" sem resolver nada nao passa.
    const recusado = await manager.commitMerge(repo, 'juntando');
    expect(recusado).toEqual({ ok: false, files: [ARQUIVO] });

    // Agora resolvido de verdade, preservando os dois lados.
    writeFileSync(join(repo, ARQUIVO), 'linha um\nalfa\nbeta\nlinha tres\n');
    const aceito = await manager.commitMerge(repo, 'juntando');
    expect(aceito).toEqual({ ok: true, filesChanged: 1 });
    expect(run(repo, 'status', '--porcelain').trim()).toBe('');
  });
});
