/**
 * Tira o JSON de uma resposta de modelo.
 *
 * A CLI devolve texto livre, e mesmo instruido a responder so JSON o modelo
 * cerca em ```json ou escreve uma frase antes. Nada disso e erro: e o formato
 * de saida de um programa de terceiro, e quem se adapta somos nos.
 *
 * O escaneamento respeita string e escape -- uma chave dentro de `"{"` nao conta
 * como abertura, e foi exatamente ai que a versao ingenua quebrava.
 */
export function extractJson(text: string): string | null {
  const fenced = fromFence(text);
  if (fenced !== null) return fenced;
  return firstObject(text);
}

/** Bloco cercado por crases, com ou sem a linguagem declarada. */
function fromFence(text: string): string | null {
  const fence = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/i.exec(text);
  const inner = fence?.[1];
  if (inner === undefined) return null;
  return firstObject(inner);
}

/** O primeiro objeto balanceado do texto, ou null. */
function firstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  // Chaves abertas e nunca fechadas: resposta cortada no meio, nao JSON parcial.
  return null;
}

/** Extrai e parseia. `null` quando nao ha JSON, ou quando ha mas esta quebrado. */
export function parseJsonLoosely(text: string): unknown {
  const json = extractJson(text);
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
