import { relative, isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Frases de ferramenta para quem nao le codigo. E aqui, e so aqui, que o nome
 * tecnico de uma ferramenta vira portugues -- o resto do sistema so repassa.
 */
export interface ToolDescription {
  readonly target?: string;
  readonly summary: string;
}

const MAX_SUMMARY = 280;

const inputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
});

const shorten = (text: string, max = 120): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Caminho absoluto dentro do projeto fica mais legivel como relativo. */
function display(path: string, cwd?: string): string {
  if (cwd === undefined || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel.length > 0 && !rel.startsWith('..') ? rel : path;
}

export function describeToolCall(tool: string, input: unknown, cwd?: string): ToolDescription {
  const parsed = inputSchema.safeParse(input);
  const fields = parsed.success ? parsed.data : {};
  const file = fields.file_path ?? fields.notebook_path ?? fields.path;
  const target = file === undefined ? undefined : display(file, cwd);
  const withTarget = (summary: string): ToolDescription =>
    target === undefined ? { summary } : { target, summary };

  switch (tool) {
    case 'Read':
      return withTarget(target === undefined ? 'Lendo um arquivo' : `Lendo ${target}`);
    case 'Edit':
      return withTarget(target === undefined ? 'Editando um arquivo' : `Editando ${target}`);
    case 'Write':
      return withTarget(target === undefined ? 'Escrevendo um arquivo' : `Escrevendo ${target}`);
    case 'NotebookEdit':
      return withTarget(target === undefined ? 'Editando um notebook' : `Editando ${target}`);
    case 'Bash': {
      const command = fields.command ?? '';
      return {
        ...(command.length > 0 ? { target: shorten(command, 80) } : {}),
        summary: command.length > 0 ? `Rodando: ${shorten(command)}` : 'Rodando um comando',
      };
    }
    case 'Glob':
      return {
        ...(fields.pattern === undefined ? {} : { target: fields.pattern }),
        summary: `Procurando arquivos${fields.pattern === undefined ? '' : `: ${shorten(fields.pattern)}`}`,
      };
    case 'Grep':
      return {
        ...(fields.pattern === undefined ? {} : { target: fields.pattern }),
        summary: `Procurando no codigo${fields.pattern === undefined ? '' : `: ${shorten(fields.pattern)}`}`,
      };
    case 'WebFetch':
    case 'WebSearch': {
      const where = fields.url ?? fields.query;
      return {
        ...(where === undefined ? {} : { target: shorten(where, 80) }),
        summary: where === undefined ? 'Consultando a internet' : `Consultando ${shorten(where)}`,
      };
    }
    case 'TodoWrite':
      return { summary: 'Organizando a propria lista de tarefas' };
    case 'AskUserQuestion':
      return { summary: 'Preparando uma pergunta para voce' };
    case 'Task':
      return {
        ...(fields.description === undefined ? {} : { target: fields.description }),
        summary: fields.description === undefined
          ? 'Passando um pedaco para outro agente'
          : `Passando adiante: ${shorten(fields.description)}`,
      };
    default:
      return withTarget(`Usando ${shorten(tool, 60)}`);
  }
}

/** Frase do desfecho da chamada. Curta: o detalhe tecnico vai em `detail`. */
export function describeToolResult(tool: string, target: string | undefined, ok: boolean): string {
  const what = target === undefined ? '' : ` ${target}`;
  if (!ok) {
    switch (tool) {
      case 'Bash':
        return `O comando${what} falhou`;
      case 'Read':
        return `Nao consegui ler${what || ' o arquivo'}`;
      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
        return `Nao consegui escrever${what || ' o arquivo'}`;
      default:
        return `${shorten(tool, 60)} nao funcionou`;
    }
  }
  switch (tool) {
    case 'Read':
      return `Leu${what || ' o arquivo'}`;
    case 'Edit':
    case 'NotebookEdit':
      return `Editou${what || ' o arquivo'}`;
    case 'Write':
      return `Escreveu${what || ' o arquivo'}`;
    case 'Bash':
      return 'Comando rodou';
    case 'Glob':
    case 'Grep':
      return 'Busca terminou';
    default:
      return `${shorten(tool, 60)} terminou`;
  }
}

/** Garante o limite que o schema do evento impoe. */
export const capSummary = (text: string): string =>
  text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1)}…`;
