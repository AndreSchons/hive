import { z } from 'zod';

/**
 * Traducao do resultado estruturado das ferramentas de arquivo para o que o
 * dominio entende. A CLI ja entrega o diff pronto, entao nao lemos o disco nem
 * rodamos `git diff` para saber o que mudou.
 */
export interface FileChange {
  readonly path: string;
  readonly change: 'created' | 'modified' | 'deleted';
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

const hunkSchema = z.object({ lines: z.array(z.string()).default([]) });

// `nullish` e nao `optional`: num arquivo novo a CLI manda `originalFile: null`,
// e um schema que so aceita `undefined` descartaria o resultado inteiro.
const fileResultSchema = z.object({
  filePath: z.string().min(1),
  /** `create` num arquivo novo; ausente numa edicao. */
  type: z.string().nullish(),
  content: z.string().nullish(),
  originalFile: z.string().nullish(),
  structuredPatch: z.array(hunkSchema).nullish(),
});

/** Conta linhas ignorando o `\n` final, que nao e uma linha a mais. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Devolve `null` quando o resultado nao e de uma ferramenta de arquivo -- e o
 * caso da maioria (`Read`, `Bash`, `Glob`).
 */
export function fileChangeFrom(result: unknown): FileChange | null {
  const parsed = fileResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const { filePath, type, content, originalFile, structuredPatch } = parsed.data;

  // Um `Read` tambem traz `filePath`, mas dentro de `file` e sem patch nenhum.
  // O que marca escrita e ter patch ou ser uma criacao declarada.
  if (type !== 'create' && type !== 'delete' && structuredPatch == null) return null;

  if (type === 'create') {
    // Medido: arquivo criado vem com `structuredPatch` vazio. Contar hunks aqui
    // reportaria "0 linhas" em todo arquivo novo.
    return {
      path: filePath,
      change: 'created',
      linesAdded: countLines(content ?? ''),
      linesRemoved: 0,
    };
  }

  if (type === 'delete') {
    return {
      path: filePath,
      change: 'deleted',
      linesAdded: 0,
      linesRemoved: countLines(originalFile ?? ''),
    };
  }

  let added = 0;
  let removed = 0;
  for (const hunk of structuredPatch ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { path: filePath, change: 'modified', linesAdded: added, linesRemoved: removed };
}
