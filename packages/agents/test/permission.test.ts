import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decidePermission, isInside } from '../src/index';

const root = mkdtempSync(join(tmpdir(), 'office-perm-'));
const fora = mkdtempSync(join(tmpdir(), 'office-fora-'));
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(fora, 'segredo.txt'), 'nao e para ler');

afterAll(() => {
  // Diretorios temporarios do sistema; o SO limpa.
});

const write = (path: string) => ({
  toolName: 'Write',
  input: { file_path: path, content: 'oi' },
  requiresUserInteraction: false,
});

describe('isInside', () => {
  it('aceita caminho dentro da pasta', () => {
    expect(isInside(root, join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('recusa a propria pasta e qualquer coisa fora dela', () => {
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, join(fora, 'segredo.txt'))).toBe(false);
  });

  it('nao se deixa enganar por .. no meio do caminho', () => {
    expect(isInside(root, join(root, 'src', '..', '..', 'escapou.txt'))).toBe(false);
  });

  it('segue o link simbolico ate onde ele aponta de verdade', () => {
    const link = join(root, 'atalho');
    symlinkSync(fora, link);
    // O caminho parece estar dentro, mas o arquivo esta fora.
    expect(isInside(root, join(link, 'segredo.txt'))).toBe(false);
  });
});

describe('decidePermission', () => {
  it('libera leitura sem parar o agente', () => {
    const decision = decidePermission(
      { toolName: 'Read', input: { file_path: join(root, 'src', 'a.ts') }, requiresUserInteraction: false },
      root,
    );
    expect(decision.kind).toBe('allow');
  });

  it('libera escrita dentro da pasta escolhida', () => {
    expect(decidePermission(write(join(root, 'src', 'novo.ts')), root).kind).toBe('allow');
  });

  it('para o agente quando a escrita sai da pasta', () => {
    const decision = decidePermission(write(join(fora, 'invasor.txt')), root);
    if (decision.kind !== 'escalate') throw new Error('esperava escalonamento');
    expect(decision.cause).toBe('permission');
    expect(decision.options.map((option) => option.id)).toEqual(['allow', 'deny']);
    // A frase precisa ser respondivel por quem nao le codigo.
    expect(decision.question).toContain('fora da pasta do projeto');
  });

  it('para o agente antes de rodar um comando', () => {
    const decision = decidePermission(
      { toolName: 'Bash', input: { command: 'rm -rf build' }, requiresUserInteraction: false },
      root,
    );
    if (decision.kind !== 'escalate') throw new Error('esperava escalonamento');
    expect(decision.cause).toBe('permission');
  });

  it('trata pergunta do agente como duvida de produto, com as opcoes dele', () => {
    const decision = decidePermission(
      {
        toolName: 'AskUserQuestion',
        requiresUserInteraction: true,
        input: {
          questions: [
            {
              question: 'O botao fica no topo ou no rodape?',
              options: [{ label: 'Topo' }, { label: 'Rodape' }],
            },
          ],
        },
      },
      root,
    );
    if (decision.kind !== 'escalate') throw new Error('esperava escalonamento');
    expect(decision.cause).toBe('agent_asked');
    expect(decision.options.map((option) => option.label)).toEqual(['Topo', 'Rodape']);
    expect(decision.allowFreeText).toBe(true);
    // O texto da pergunta e a chave que a CLI usa para receber a resposta.
    expect(decision.ask?.questionText).toBe('O botao fica no topo ou no rodape?');
    // O input cru precisa sobreviver inteiro: a CLI revalida os campos dela.
    expect(decision.ask?.input).toMatchObject({ questions: [{ question: 'O botao fica no topo ou no rodape?' }] });
  });
});
