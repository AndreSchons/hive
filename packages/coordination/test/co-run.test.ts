import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractId, subtaskSchema, type Contract, type Subtask } from '@office/protocol';
import { areasCollide, chooseCoRunnable, pathsOverlap } from '../src/co-run';
import { CONTRACTS_DIR, contractBrief, contractPath, materializeContracts } from '../src/contract-artifact';

const passo = (id: string, allowedPaths: string[], dependsOn: string[] = []): Subtask =>
  subtaskSchema.parse({
    id,
    title: id,
    description: `faz ${id}`,
    role: 'backend',
    dependsOn,
    allowedPaths,
    doneWhen: 'esta pronto',
    gate: { id: `gate_${id}`, kind: 'typecheck', command: 'true' },
    budget: {},
  });

describe('quando duas areas se encostam', () => {
  it('pasta que contem a outra e a mesma area', () => {
    expect(pathsOverlap('src/api', 'src/api/routes.ts')).toBe(true);
    expect(pathsOverlap('src/api/routes.ts', 'src/api')).toBe(true);
  });

  /**
   * Comparar texto cru diria que `src/api` cobre `src/apiv2`. Nao cobre, e
   * acreditar que cobre poria em fila dois passos que nunca se cruzariam.
   */
  it('nome parecido nao e a mesma pasta', () => {
    expect(pathsOverlap('src/api', 'src/apiv2')).toBe(false);
    expect(pathsOverlap('packages/protocol', 'packages/protocolo')).toBe(false);
  });

  it('a raiz cobre tudo', () => {
    expect(pathsOverlap('.', 'src/api')).toBe(true);
    expect(pathsOverlap('', 'qualquer/coisa')).toBe(true);
  });

  it('barra sobrando e ./ na frente nao mudam nada', () => {
    expect(pathsOverlap('./src/api/', 'src/api')).toBe(true);
  });

  /**
   * Sem area declarada o agente pode mexer em qualquer lugar, e ai correr junto
   * com quem for e apostar. O plano que declara suas areas ganha paralelismo; o
   * que nao declara continua na fila.
   */
  it('subtask sem area declarada encosta em todo mundo', () => {
    expect(areasCollide(passo('a', []), passo('b', ['src/ui']))).toBe(true);
    expect(areasCollide(passo('a', []), passo('b', []))).toBe(true);
  });

  it('areas separadas nao se encostam', () => {
    expect(areasCollide(passo('a', ['src/api']), passo('b', ['src/ui']))).toBe(false);
  });
});

describe('quem corre junto com quem', () => {
  it('duas areas separadas partem juntas', () => {
    const escolha = chooseCoRunnable([passo('a', ['src/api']), passo('b', ['src/ui'])], [], 2);

    expect(escolha.start.map((subtask) => subtask.id)).toEqual(['a', 'b']);
    expect(escolha.held).toHaveLength(0);
  });

  /**
   * O caso que o paralelismo existe para nao piorar: liberadas pelo grafo, mas
   * mexendo no mesmo lugar. Segurar aqui custa esperar; descobrir depois custa
   * um agente inteiro desfazendo o merge.
   */
  it('segura quem mexe na area de quem ja esta rodando', () => {
    const escolha = chooseCoRunnable(
      [passo('a', ['src/api']), passo('b', ['src/api/rotas.ts'])],
      [],
      2,
    );

    expect(escolha.start.map((subtask) => subtask.id)).toEqual(['a']);
    expect(escolha.held.map((subtask) => subtask.id)).toEqual(['b']);
  });

  it('respeita quem ja esta no ar, e nao so quem esta escolhendo agora', () => {
    const escolha = chooseCoRunnable([passo('b', ['src/api/rotas.ts'])], [passo('a', ['src/api'])], 2);

    expect(escolha.start).toHaveLength(0);
    expect(escolha.held.map((subtask) => subtask.id)).toEqual(['b']);
  });

  it('nunca larga mais que o teto, mesmo com tudo liberado e separado', () => {
    const escolha = chooseCoRunnable(
      [passo('a', ['um']), passo('b', ['dois']), passo('c', ['tres'])],
      [],
      2,
    );

    expect(escolha.start).toHaveLength(2);
  });

  /**
   * Esperar a vez nao e sinal de nada -- so o que ficou de fora **tendo lugar**
   * mede paralelismo perdido. Contar fila junto inflaria a medida ate o ponto
   * de ela nao querer dizer mais nada.
   */
  it('quem so esperou lugar nao conta como area compartilhada', () => {
    const escolha = chooseCoRunnable(
      [passo('a', ['um']), passo('b', ['dois']), passo('c', ['tres'])],
      [],
      2,
    );

    expect(escolha.held).toHaveLength(0);
  });

  it('ordem do plano decide o desempate', () => {
    const escolha = chooseCoRunnable([passo('z', ['um']), passo('a', ['dois'])], [], 1);

    expect(escolha.start.map((subtask) => subtask.id)).toEqual(['z']);
  });
});

describe('o contrato como artefato', () => {
  let copia: string;

  const contrato: Contract = {
    id: contractId.parse('schema-do-login'),
    kind: 'types',
    title: 'Formato do login',
    body: 'type Login = { email: string }',
  };

  beforeEach(() => {
    copia = mkdtempSync(join(tmpdir(), 'contrato-'));
  });
  afterEach(() => {
    rmSync(copia, { recursive: true, force: true });
  });

  it('vira arquivo dentro da copia, com o conteudo inteiro', async () => {
    await materializeContracts(copia, [contrato]);

    const texto = readFileSync(join(copia, contractPath(contrato)), 'utf8');
    expect(texto).toContain('Formato do login');
    expect(texto).toContain('type Login = { email: string }');
  });

  it('mora sob a pasta do app, que e o que `commitAll` mantem fora do projeto', () => {
    expect(contractPath(contrato).startsWith(CONTRACTS_DIR)).toBe(true);
  });

  /** Id e string livre, e o gerente escreve slug legivel. Nome de arquivo nao pode quebrar. */
  it('id com caracter estranho ainda vira nome de arquivo', () => {
    const caminho = contractPath({ ...contrato, id: contractId.parse('rotas/da API v2!') });

    expect(caminho).toBe(`${CONTRACTS_DIR}/rotas-da-API-v2.md`);
  });

  /**
   * O prompt leva o conteudo **e** o caminho: so o caminho seria uma ida a mais
   * para uma leitura obrigatoria, e so o texto perderia a referencia estavel na
   * hora de o agente conferir o que combinou.
   */
  it('o texto do prompt traz o conteudo e onde ele mora', () => {
    const texto = contractBrief(contrato);

    expect(texto).toContain('type Login = { email: string }');
    expect(texto).toContain(contractPath(contrato));
  });

  it('sem contrato nenhum nao cria pasta a toa', async () => {
    await materializeContracts(copia, []);

    expect(() => readFileSync(join(copia, CONTRACTS_DIR), 'utf8')).toThrow();
  });
});
