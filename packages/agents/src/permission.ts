import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { BlockCause } from '@hive/protocol';
import { describeToolCall } from './tool-summary';

/**
 * Politica de permissao. A CLI suspende o agente e pergunta antes de cada
 * ferramenta que nao esta liberada; esta funcao decide o que passa direto e o
 * que vira pergunta para o humano.
 *
 * O criterio e "seguro e dentro da pasta": ler e escrever dentro do projeto
 * escolhido passa sozinho, porque parar a cada arquivo tornaria o produto
 * inusavel. Sair da pasta, rodar comando ou tocar a rede para o agente.
 *
 * A politica e **uma so para todas as CLIs**. Cada adaptador traduz o pedido da
 * sua CLI para `PermissionRequest` e recebe a mesma decisao de volta: o que o
 * sistema deixa um agente fazer nao pode depender de qual CLI ele e.
 */
export type PermissionDecision =
  | { readonly kind: 'allow' }
  /**
   * Recusa sem perguntar a ninguem. `message` vai para o **agente**, nao para a
   * pessoa: e a instrucao do que fazer no lugar.
   */
  | { readonly kind: 'deny'; readonly message: string }
  | {
      readonly kind: 'escalate';
      readonly cause: BlockCause;
      readonly question: string;
      readonly context: string;
      readonly options: readonly { readonly id: string; readonly label: string }[];
      readonly allowFreeText: boolean;
      /**
       * So no `AskUserQuestion`. Guarda o input **cru** da ferramenta: devolver
       * a versao ja passada pelo nosso schema perderia campos que a CLI exige
       * de volta (`header`, `multiSelect`), e a ferramenta recusaria a resposta.
       */
      readonly ask?: { readonly questionText: string; readonly input: unknown };
    };

/**
 * Classe da ferramenta quando a CLI ja informa. Sem ela,
 * quem classifica e o nome da ferramenta.
 */
export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

/**
 * Como a politica trata este pedido. `read-only` e para o agente que so precisa
 * olhar -- o gerente planejando, por exemplo: qualquer escrita ou comando e
 * recusado, mesmo dentro da pasta do projeto.
 */
export interface PermissionOptions {
  readonly readOnly?: boolean;
}

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly requiresUserInteraction: boolean;
  readonly kind?: ToolKind;
  /** Caminhos que a propria CLI ja resolveu. Tem precedencia sobre o input cru. */
  readonly paths?: readonly string[];
}

/** Leem sem efeito colateral e sem sair da maquina. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite']);
/** Escrevem em arquivo: liberadas so dentro da pasta do projeto. */
const FILE_WRITERS = new Set(['Edit', 'Write', 'NotebookEdit']);

const READ_ONLY_KINDS = new Set<ToolKind>(['read', 'search', 'think']);
const FILE_WRITER_KINDS = new Set<ToolKind>(['edit', 'delete', 'move']);

const pathInput = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  path: z.string().optional(),
});

const askInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        options: z
          .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
          .default([]),
      }),
    )
    .min(1),
});

/**
 * Resolve simbolicos ate o ancestral que ja existe: o arquivo de um `Write`
 * ainda nao esta no disco, entao `realpath` nele falharia.
 */
function resolveHonestly(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.push(current.slice(parent.length + 1));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...missing.reverse());
  } catch {
    return resolve(path);
  }
}

/** Verdadeiro so quando `path` esta mesmo dentro de `root`. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolveHonestly(root), resolveHonestly(path));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Os caminhos que este pedido toca, venham da CLI ja resolvidos ou do input cru. */
function targetPaths(request: PermissionRequest): string[] {
  if (request.paths !== undefined && request.paths.length > 0) return [...request.paths];
  const fields = pathInput.safeParse(request.input);
  if (!fields.success) return [];
  const { file_path: file, notebook_path: notebook, path } = fields.data;
  return [file ?? notebook ?? path].filter((value): value is string => value !== undefined);
}

/** A frase principal da pergunta, por ferramenta: o que ela faz, sem o comando. */
const QUESTION_BY_TOOL: Readonly<Partial<Record<string, string>>> = {
  Bash: 'O agente quer rodar um comando no seu computador.',
  WebFetch: 'O agente quer abrir uma pagina da internet.',
  WebSearch: 'O agente quer pesquisar na internet.',
};

const ALLOW_DENY = [
  { id: 'allow', label: 'Pode fazer' },
  { id: 'deny', label: 'Nao, deixa quieto' },
] as const;

function askPermission(question: string, context: string): PermissionDecision {
  return {
    kind: 'escalate',
    cause: 'permission',
    question,
    context,
    options: [...ALLOW_DENY],
    // Texto livre viraria recusa com explicacao; a decisao em si e binaria.
    allowFreeText: false,
  };
}

export function decidePermission(
  request: PermissionRequest,
  projectPath: string,
  options: PermissionOptions = {},
): PermissionDecision {
  const { toolName, input, requiresUserInteraction } = request;

  // O agente perguntando de verdade. Nao e permissao: e duvida de produto.
  if (requiresUserInteraction) {
    const parsed = askInput.safeParse(input);
    const first = parsed.success ? parsed.data.questions[0] : undefined;
    if (first === undefined) {
      return {
        kind: 'escalate',
        cause: 'agent_asked',
        question: 'O agente tem uma duvida antes de continuar.',
        context: 'Ele parou e esta esperando sua resposta.',
        options: [],
        allowFreeText: true,
      };
    }
    return {
      kind: 'escalate',
      cause: 'agent_asked',
      question: first.question,
      context: 'O agente parou aqui porque essa decisao e sua, nao dele.',
      options: first.options.map((option) => ({ id: option.label, label: option.label })),
      allowFreeText: true,
      ask: { questionText: first.question, input },
    };
  }

  if (READ_ONLY.has(toolName) || (request.kind !== undefined && READ_ONLY_KINDS.has(request.kind))) {
    return { kind: 'allow' };
  }

  // Somente-leitura: ler ja passou acima, e daqui pra baixo tudo escreve, roda
  // ou sai da maquina. Nada disso e trabalho de quem so deveria estar olhando,
  // e por isso nao vira pergunta: perguntar "pode rodar este grep?" a quem nao
  // le codigo e pedir uma decisao que ela nao tem como tomar. A recusa volta
  // para o agente com o caminho certo -- sem ele, o gerente barrado saia
  // abrindo caminho no chute e planejava no escuro.
  if (options.readOnly === true) {
    return {
      kind: 'deny',
      message:
        'Voce esta so olhando o projeto: nao rode comandos nem altere arquivos. ' +
        'Para procurar use Glob (arquivos por nome) e Grep (texto dentro dos arquivos), e Read para ler.',
    };
  }

  if (FILE_WRITERS.has(toolName) || (request.kind !== undefined && FILE_WRITER_KINDS.has(request.kind))) {
    const targets = targetPaths(request);
    // Renomear toca dois caminhos, e basta um deles estar fora para escalar.
    if (targets.length > 0 && targets.every((target) => isInside(projectPath, target))) {
      return { kind: 'allow' };
    }

    const { summary } = describeToolCall(toolName, input, projectPath);
    const fora = targets.find((target) => !isInside(projectPath, target));
    return askPermission(
      fora === undefined
        ? 'O agente quer mexer num arquivo que nao consegui identificar. Pode?'
        : `O agente quer mexer em ${fora}, que esta fora da pasta do projeto. Pode?`,
      `${summary}. Arquivos fora da pasta escolhida nao entram sozinhos.`,
    );
  }

  // O comando cru nao entra na frase principal: "Rodando: cd x && grep -rniE"
  // nao e uma pergunta que quem nao le codigo consiga responder. Ele fica no
  // contexto, para quem quiser conferir.
  const { summary } = describeToolCall(toolName, input, projectPath);
  return askPermission(
    `${QUESTION_BY_TOOL[toolName] ?? 'O agente quer usar uma ferramenta que mexe fora do projeto.'} Pode?`,
    // "Sai da pasta" nao e verdade para todo comando -- a maioria roda dentro
    // da copia. O que e verdade e que o app nao consegue garantir onde ele
    // para, e e por isso que a pergunta existe.
    `${summary}. Eu nao consigo garantir que isso fique so dentro do projeto, entao a decisao e sua.`,
  );
}
