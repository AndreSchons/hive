import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Contract } from '@office/protocol';

/**
 * O contrato como artefato de verdade, e nao so como paragrafo de prompt.
 *
 * Contrato antes de paralelismo so vale se os dois especialistas estiverem
 * lendo **a mesma coisa**. Texto colado no prompt some do contexto do agente
 * assim que a conversa cresce; um arquivo na pasta ele reabre quando quiser, e
 * e o mesmo byte nas duas copias.
 */

/** Onde o artefato mora dentro da copia do agente. */
export const CONTRACTS_DIR = '.office/contratos';

/** Caminho relativo a raiz da copia. Vai para `Contract.path` como declarado. */
export const contractPath = (contract: Contract): string =>
  posix.join(CONTRACTS_DIR, `${slug(contract.id)}.md`);

/**
 * Escreve os contratos na copia. Nao commita e nao entra no projeto da pessoa:
 * `commitAll` tira `.office/` do indice pela mesma razao que tira
 * `node_modules` -- e andaime do app, e um andaime que virasse commit seria uma
 * decisao de projeto tomada por quem so ia conferir trabalho.
 */
export async function materializeContracts(
  worktreePath: string,
  contracts: readonly Contract[],
): Promise<void> {
  if (contracts.length === 0) return;
  await mkdir(join(worktreePath, ...CONTRACTS_DIR.split('/')), { recursive: true });
  await Promise.all(
    contracts.map((contract) =>
      writeFile(join(worktreePath, contractPath(contract)), render(contract), 'utf8'),
    ),
  );
}

/**
 * O que o agente le no prompt: o conteudo **e** onde ele mora. So o caminho
 * seria uma ida a mais para uma leitura obrigatoria; so o texto perderia a
 * referencia estavel na hora de conferir.
 */
export const contractBrief = (contract: Contract): string =>
  `${render(contract)}\n(este combinado tambem esta em \`${contractPath(contract)}\`)`;

const render = (contract: Contract): string =>
  [`# ${contract.title}`, '', `Tipo: ${contract.kind}`, '', contract.body, ''].join('\n');

/** Nome de arquivo previsivel a partir de um id que e string livre. */
const slug = (id: string): string =>
  id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'contrato';
