import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { agentId as agentIdSchema, type AgentId } from '@office/protocol';
import type {
  CreateWorktreeInput,
  MergeResult,
  Worktree,
  WorktreeDiff,
  WorktreeManager,
} from '../worktree';
import { git, gitOrThrow, lines } from './git';

/** Prefixo dos branches que este app cria. E o que separa nossa copia da do usuario. */
export const BRANCH_PREFIX = 'office/';

export const branchFor = (agent: AgentId): string => `${BRANCH_PREFIX}${agent}`;

/** Estado do repositorio antes de deixar qualquer agente comecar. */
export type RepositoryCheck =
  | {
      readonly ok: true;
      readonly branch: string;
      /**
       * O commit em que o branch estava. Todas as copias de uma execucao saem
       * **deste ponto**, e nao da ponta do branch, que anda a cada integracao.
       * E o que faz o trabalho de cada agente ser independente da ordem da fila
       * -- e o que torna um conflito de verdade possivel de acontecer.
       */
      readonly commit: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Isolamento por git worktree, com git de verdade. Conflito, arvore suja e
 * pasta que nao e repositorio sao **respostas**, nunca excecoes: cada uma vira
 * uma frase que quem nao le codigo consegue entender.
 */
export class GitWorktreeManager implements WorktreeManager {
  /**
   * O repositorio esta pronto para receber agentes? Mergear dentro de uma
   * arvore suja misturaria o trabalho da pessoa com o dos agentes, entao isso e
   * recusado antes de qualquer coisa comecar.
   */
  async check(repositoryPath: string): Promise<RepositoryCheck> {
    const inside = await git(repositoryPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return {
        ok: false,
        reason:
          'Esta pasta ainda nao e um repositorio git, e eu preciso disso para separar o trabalho de cada agente.',
      };
    }

    const head = await git(repositoryPath, ['rev-parse', 'HEAD']);
    if (head.code !== 0) {
      return {
        ok: false,
        reason:
          'Este repositorio ainda nao tem nenhum commit, entao nao ha de onde partir. Faca o primeiro commit e tente de novo.',
      };
    }

    const dirty = await git(repositoryPath, ['status', '--porcelain']);
    if (lines(dirty.stdout).length > 0) {
      return {
        ok: false,
        reason:
          'Voce tem mudancas ainda nao salvas neste projeto. Guarde ou descarte essas mudancas antes, para o trabalho dos agentes nao se misturar com o seu.',
      };
    }

    return {
      ok: true,
      branch: await this.currentBranch(repositoryPath),
      commit: head.stdout.trim(),
    };
  }

  async currentBranch(repositoryPath: string): Promise<string> {
    const result = await gitOrThrow(repositoryPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.trim();
  }

  /** Limpa registro de worktree cuja pasta sumiu -- sobra de um app que caiu. */
  async prune(repositoryPath: string): Promise<void> {
    await git(repositoryPath, ['worktree', 'prune']);
  }

  async create(input: CreateWorktreeInput): Promise<Worktree> {
    await mkdir(dirname(input.path), { recursive: true });
    // Um branch sobrando de uma execucao anterior faria o `add` falhar; como o
    // nome carrega o agentId, que e unico, nada de vivo mora nele.
    await git(input.repositoryPath, ['branch', '-D', input.branch]);
    await gitOrThrow(input.repositoryPath, [
      'worktree', 'add', '-b', input.branch, input.path, input.base,
    ]);

    return {
      agentId: input.agentId,
      repositoryPath: input.repositoryPath,
      path: input.path,
      branch: input.branch,
      base: input.base,
      createdAt: Date.now(),
    };
  }

  async list(repositoryPath: string): Promise<readonly Worktree[]> {
    const output = await gitOrThrow(repositoryPath, ['worktree', 'list', '--porcelain']);
    const base = await this.currentBranch(repositoryPath);
    const found: Worktree[] = [];
    let path: string | null = null;

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      if (!line.startsWith('branch ') || path === null) continue;

      const branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
      // So o que este app criou: o agentId vive no proprio nome do branch, e e
      // o unico jeito de recuperar de quem era a copia depois de um reinicio.
      if (!branch.startsWith(BRANCH_PREFIX)) continue;
      const parsed = agentIdSchema.safeParse(branch.slice(BRANCH_PREFIX.length));
      if (!parsed.success) continue;

      found.push({
        agentId: parsed.data, repositoryPath, path, branch, base, createdAt: 0,
      });
    }
    return found;
  }

  async diff(worktree: Worktree): Promise<WorktreeDiff> {
    const numstat = await gitOrThrow(worktree.repositoryPath, [
      'diff', '--numstat', `${worktree.base}...${worktree.branch}`,
    ]);
    const count = await gitOrThrow(worktree.repositoryPath, [
      'rev-list', '--count', `${worktree.base}..${worktree.branch}`,
    ]);

    const files = lines(numstat).map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      return {
        path: rest.join('\t'),
        // `-` no numstat quer dizer binario, e ai contar linha nao significa nada.
        added: Number.parseInt(added ?? '0', 10) || 0,
        removed: Number.parseInt(removed ?? '0', 10) || 0,
      };
    });

    return { files, commits: Number.parseInt(count.trim(), 10) || 0 };
  }

  /**
   * Salva o que o agente deixou na copia. A CLI nao commita sozinha e a politica
   * de permissao escala `Bash`, entao sem isto nao existe nada para mergear.
   * Devolve falso quando o agente nao mudou nada.
   */
  async commitAll(worktree: Worktree, message: string): Promise<boolean> {
    // `node_modules` fica de fora sempre, mesmo que o projeto nao o ignore: a
    // preparacao instala dependencia dentro da copia, e um projeto sem
    // `.gitignore` veria isso virar commit no repositorio de quem usa o app.
    //
    // Estagiar tudo e **depois** tirar, em vez de excluir no `add`: um `add`
    // com pathspec explicito **falha** quando o pathspec alcanca arquivo que o
    // `.gitignore` cobre ("use -f if you really want to add them"), e ai a
    // entrega inteira morre no projeto mais comum que existe -- um que ignora
    // `node_modules`, como todos ignoram.
    await gitOrThrow(worktree.path, ['add', '-A']);
    // Sem `glob` o `**` do git tambem casa `/`, e `pkg/node_modules` escapava.
    // Nao lanca: sem nada estagiado nessas pastas, o reset nao tem o que fazer.
    await git(worktree.path, [
      'reset', '-q', '--', ':(glob,top)**/node_modules/**', ':(glob,top)node_modules/**',
    ]);
    const staged = await git(worktree.path, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) return false;

    await gitOrThrow(worktree.path, [
      '-c', 'user.name=Agent Office', '-c', 'user.email=agent@office.local',
      'commit', '--no-verify', '-m', message,
    ]);
    return true;
  }

  /**
   * Integra a copia no branch destino. Conflito e resposta, e o merge fica
   * **em curso** de proposito: e o que permite resolver depois sem refazer nada,
   * e e literalmente "detectar e parar".
   */
  async merge(worktree: Worktree, into: string): Promise<MergeResult> {
    const repository = worktree.repositoryPath;
    const current = await this.currentBranch(repository);
    if (current !== into) {
      throw new Error(`o repositorio esta em "${current}" e o merge era para "${into}"`);
    }

    const before = (await gitOrThrow(repository, ['rev-parse', 'HEAD'])).trim();
    const merge = await git(repository, ['merge', '--no-ff', '--no-edit', worktree.branch]);

    if (merge.code !== 0) {
      const conflicted = await this.conflictFiles(repository);
      if (conflicted.length === 0) {
        throw new Error(`o merge de ${worktree.branch} falhou: ${merge.stderr.trim()}`);
      }
      return { status: 'conflict', files: conflicted };
    }

    const after = (await gitOrThrow(repository, ['rev-parse', 'HEAD'])).trim();
    if (after === before) return { status: 'empty' };

    const changed = await gitOrThrow(repository, ['diff', '--name-only', before, after]);
    return { status: 'merged', filesChanged: lines(changed).length };
  }

  /** Arquivos que os dois lados tocaram, no merge que esta em curso agora. */
  async conflictFiles(repositoryPath: string): Promise<string[]> {
    const result = await git(repositoryPath, ['diff', '--name-only', '--diff-filter=U']);
    return result.code === 0 ? lines(result.stdout) : [];
  }

  /** Desfaz o merge em curso e devolve o repositorio ao estado anterior. */
  async abortMerge(repositoryPath: string): Promise<void> {
    await git(repositoryPath, ['merge', '--abort']);
  }

  /**
   * Fecha o merge que estava em curso. Antes disso confere que nao sobrou
   * marcador de conflito: nenhum agente aprova o proprio trabalho, e sem portao
   * de verificacao de verdade esta e a checagem objetiva minima. Ela prova
   * ausencia de marcador, nao que a juncao ficou correta.
   */
  async commitMerge(
    repositoryPath: string,
    message: string,
  ): Promise<{ readonly ok: true; readonly filesChanged: number } | { readonly ok: false; readonly files: string[] }> {
    const before = (await gitOrThrow(repositoryPath, ['rev-parse', 'HEAD'])).trim();

    // Estagiar antes de conferir: git marca o arquivo como nao resolvido ate
    // ele ser adicionado, entao checar a marca do indice primeiro reprovaria
    // ate quem resolveu direito. O que decide e o texto que sobrou.
    await gitOrThrow(repositoryPath, ['add', '-A']);
    const unresolved = await this.markerFiles(repositoryPath);
    if (unresolved.length > 0) return { ok: false, files: unresolved };
    await gitOrThrow(repositoryPath, [
      '-c', 'user.name=Agent Office', '-c', 'user.email=agent@office.local',
      'commit', '--no-verify', '-m', message,
    ]);

    const after = (await gitOrThrow(repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const changed = await gitOrThrow(repositoryPath, ['diff', '--name-only', before, after]);
    return { ok: true, filesChanged: lines(changed).length };
  }

  /** Arquivos onde sobrou marcador de conflito no texto. */
  async markerFiles(repositoryPath: string): Promise<string[]> {
    const marked = await git(repositoryPath, [
      'grep', '--files-with-matches', '--no-color', '-e', '^<<<<<<< ', '--', '.',
    ]);
    return lines(marked.stdout);
  }

  /** Tudo que ainda esta pendente: sem resolver no indice ou com marcador no texto. */
  async unresolvedFiles(repositoryPath: string): Promise<string[]> {
    const staged = await this.conflictFiles(repositoryPath);
    return [...new Set([...staged, ...(await this.markerFiles(repositoryPath))])];
  }

  /**
   * Tira a copia do disco. `keepBranch` existe so para depuracao: por padrao o
   * branch vai junto, porque um por agente por execucao encheria o repositorio
   * de quem esta usando o app -- e o trabalho integrado ja esta no commit de
   * merge, que guarda o nome do branch na mensagem.
   */
  async remove(
    worktree: Worktree,
    options?: { readonly force?: boolean; readonly keepBranch?: boolean },
  ): Promise<void> {
    const args = ['worktree', 'remove', worktree.path];
    if (options?.force !== false) args.splice(2, 0, '--force');
    await git(worktree.repositoryPath, args);
    await git(worktree.repositoryPath, ['worktree', 'prune']);
    if (options?.keepBranch !== true) {
      await git(worktree.repositoryPath, ['branch', '-D', worktree.branch]);
    }
  }
}
