import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decidePermission, isInside } from '../src/index';

const root = mkdtempSync(join(tmpdir(), 'hive-perm-'));
const fora = mkdtempSync(join(tmpdir(), 'hive-fora-'));
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
    // `junction` porque symlink de verdade pede admin no Windows; fora dele e ignorado.
    symlinkSync(fora, link, 'junction');
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

  it('em modo leitura, escrever dentro da pasta e recusado sem perguntar', () => {
    const dentro = join(root, 'src', 'app.ts');
    const pedido = { toolName: 'Write', input: { file_path: dentro }, requiresUserInteraction: false };

    // A mesma escrita, no mesmo lugar: o que muda e so o modo.
    expect(decidePermission(pedido, root).kind).toBe('allow');

    expect(decidePermission(pedido, root, { readOnly: true }).kind).toBe('deny');
  });

  it('em modo leitura, ler continua passando pelas duas CLIs', () => {
    const porNome = decidePermission(
      { toolName: 'Read', input: { file_path: join(root, 'src', 'app.ts') }, requiresUserInteraction: false },
      root,
      { readOnly: true },
    );
    // Uma CLI pode mandar `kind`; o Claude manda so o nome. A decisao e a mesma.
    const porKind = decidePermission(
      { toolName: 'ler arquivo', kind: 'read', input: {}, requiresUserInteraction: false },
      root,
      { readOnly: true },
    );
    expect(porNome.kind).toBe('allow');
    expect(porKind.kind).toBe('allow');
  });

  it('em modo leitura, rodar comando e recusado e o agente aprende o caminho certo', () => {
    const decision = decidePermission(
      { toolName: 'Bash', input: { command: 'grep -rn parede src' }, requiresUserInteraction: false },
      root,
      { readOnly: true },
    );
    // Ninguem e perguntado: quem nao le codigo nao tem como julgar um grep.
    if (decision.kind !== 'deny') throw new Error('esperava recusa');
    expect(decision.message).toContain('Grep');
    expect(decision.message).toContain('Glob');
  });

  it('a pergunta sobre comando nao traz o comando na frase principal', () => {
    const decision = decidePermission(
      { toolName: 'Bash', input: { command: 'cd src && grep -rniE "wall" .' }, requiresUserInteraction: false },
      root,
    );
    if (decision.kind !== 'escalate') throw new Error('esperava escalonamento');
    expect(decision.question).toBe('O agente quer rodar um comando no seu computador. Pode?');
    expect(decision.context).toContain('grep');
  });
});

/**
 * Comandos que nao rodam nem com "pode". O `pkill -f electron` autorizado pela
 * pessoa matou o proprio Hive no meio de uma execucao.
 */
describe('comandos que nenhum agente roda', () => {
  const root = '/projeto';
  const decide = (command: string) =>
    decidePermission({ toolName: 'Bash', input: { command }, requiresUserInteraction: false }, root);

  it.each([
    'pkill -f "electron" || true',
    'kill -9 1234',
    'sleep 2 && killall node',
    'sudo /usr/bin/pkill electron',
    'git add -A && git commit -m "pronto"',
    'git -c user.name=x commit -m y',
    'git push origin main',
    'sleep 5 && import -window root /tmp/tela.png',
    'xwd -root | convert xwd:- /tmp/tela.png',
    'timeout 30 scrot /tmp/tela.png',
  ])('recusa sem perguntar: %s', (command) => {
    const decision = decide(command);
    if (decision.kind !== 'deny') throw new Error(`esperava recusa para ${command}`);
    expect(decision.message.length).toBeGreaterThan(0);
  });

  it.each([
    'pnpm typecheck',
    'git status',
    'git log --oneline -3',
    'grep -rn kill src',
    "python3 - <<'EOF'\nimport sqlite3\nEOF",
  ])('nao confunde com comando comum: %s', (command) => {
    expect(decide(command).kind).not.toBe('deny');
  });

  it('a recusa vale tambem no modo somente-leitura, com a instrucao especifica', () => {
    const decision = decidePermission(
      { toolName: 'Bash', input: { command: 'git commit -m x' }, requiresUserInteraction: false },
      root,
      { readOnly: true },
    );
    if (decision.kind !== 'deny') throw new Error('esperava recusa');
    expect(decision.message).toContain('commito');
  });
});
