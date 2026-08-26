/**
 * Leitor de NDJSON vindo do stdout de uma CLI. As CLIs de agente misturam JSON
 * com avisos em texto puro (warning de versao, aviso de autenticacao), entao
 * linha que nao faz parse nao derruba a execucao: vira `malformed` e o
 * adaptador decide se ignora ou registra.
 */
export type StreamLine =
  | { readonly kind: 'json'; readonly value: unknown; readonly raw: string }
  | { readonly kind: 'malformed'; readonly raw: string };

/** Quebra um fluxo de pedacos em linhas, segurando a linha parcial entre eles. */
export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
  }

  /** Devolve o que sobrou quando o processo fecha o stdout sem newline final. */
  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = '';
    return rest.length > 0 ? [rest] : [];
  }
}

export function parseLine(raw: string): StreamLine {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return { kind: 'malformed', raw };
  }
  try {
    return { kind: 'json', value: JSON.parse(trimmed), raw };
  } catch {
    return { kind: 'malformed', raw };
  }
}

/** Converte um stream de texto em linhas ja classificadas. */
export async function* readStreamJson(
  source: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<StreamLine, void, undefined> {
  const splitter = new LineSplitter();
  const decoder = new TextDecoder();

  for await (const chunk of source) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (const line of splitter.push(text)) {
      yield parseLine(line);
    }
  }
  for (const line of splitter.flush()) {
    yield parseLine(line);
  }
}
