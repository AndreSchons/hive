import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { BlockCause } from '@office/protocol';
import { describeToolCall } from './tool-summary';

/**
 * Politica de permissao. A CLI suspende o agente e pergunta antes de cada
 * ferramenta que nao esta liberada; esta funcao decide o que passa direto e o
 * que vira pergunta para o humano.
 *
 * O criterio e "seguro e dentro da pasta": ler e escrever dentro do projeto
 * escolhido passa sozinho, porque parar a cada arquivo tornaria o produto
 * inusavel. Sair da pasta, rodar comando ou tocar a rede para o agente.
 */
export type PermissionDecision =
  | { readonly kind: 'allow' }
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

export interface PermissionRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly requiresUserInteraction: boolean;
}

/** Leem sem efeito colateral e sem sair da maquina. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite']);
/** Escrevem em arquivo: liberadas so dentro da pasta do projeto. */
const FILE_WRITERS = new Set(['Edit', 'Write', 'NotebookEdit']);

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

  if (READ_ONLY.has(toolName)) return { kind: 'allow' };

  if (FILE_WRITERS.has(toolName)) {
    const fields = pathInput.safeParse(input);
    const target = fields.success
      ? (fields.data.file_path ?? fields.data.notebook_path ?? fields.data.path)
      : undefined;
    if (target !== undefined && isInside(projectPath, target)) return { kind: 'allow' };

    const { summary } = describeToolCall(toolName, input, projectPath);
    return askPermission(
      target === undefined
        ? 'O agente quer mexer num arquivo que nao consegui identificar. Pode?'
        : `O agente quer mexer em ${target}, que esta fora da pasta do projeto. Pode?`,
      `${summary}. Arquivos fora da pasta escolhida nao entram sozinhos.`,
    );
  }

  const { summary } = describeToolCall(toolName, input, projectPath);
  return askPermission(`${summary}. Pode?`, 'Isso sai da pasta do projeto, entao a decisao e sua.');
}
