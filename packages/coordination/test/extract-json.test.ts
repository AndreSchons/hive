import { describe, expect, it } from 'vitest';
import { extractJson, parseJsonLoosely } from '../src/index';

describe('extractJson', () => {
  it('tira o JSON de dentro do bloco cercado', () => {
    const text = 'Olhei o projeto e dividi assim:\n\n```json\n{"subtasks": [1]}\n```\n\nQualquer coisa me avise.';
    expect(extractJson(text)).toBe('{"subtasks": [1]}');
  });

  it('aceita bloco cercado sem a linguagem declarada', () => {
    expect(extractJson('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('acha o objeto mesmo com prosa em volta e sem cerca', () => {
    expect(extractJson('Aqui esta: {"a": 1} -- pronto.')).toBe('{"a": 1}');
  });

  it('fecha na chave certa quando ha objetos aninhados', () => {
    const text = '{"a": {"b": {"c": 1}}, "d": 2} e sobrou texto {"outro": 1}';
    expect(extractJson(text)).toBe('{"a": {"b": {"c": 1}}, "d": 2}');
  });

  it('ignora chave que esta dentro de string', () => {
    // Era aqui que a versao ingenua fechava cedo e devolvia JSON pela metade.
    const text = '{"comando": "echo {", "fim": "}"}';
    expect(extractJson(text)).toBe(text);
    expect(parseJsonLoosely(text)).toEqual({ comando: 'echo {', fim: '}' });
  });

  it('ignora chave escapada dentro de string', () => {
    const text = '{"texto": "aspas \\" e chave }", "ok": true}';
    expect(parseJsonLoosely(text)).toEqual({ texto: 'aspas " e chave }', ok: true });
  });

  it('devolve null quando nao ha JSON nenhum', () => {
    expect(extractJson('nao sei o que voce quer que eu faca')).toBeNull();
    expect(parseJsonLoosely('nao sei')).toBeNull();
  });

  it('devolve null quando a resposta foi cortada no meio', () => {
    expect(extractJson('{"subtasks": [{"id": "a"')).toBeNull();
  });

  it('devolve null quando o JSON existe mas esta quebrado', () => {
    expect(parseJsonLoosely('{"a": 1,,}')).toBeNull();
  });
});
