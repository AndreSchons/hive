import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Gate, GateKind, TaskId } from '@office/protocol';
import type { Worktree } from '@office/agents';
import { installCommand } from './project-context';

export type GateResult =
  | { readonly status: 'passed'; readonly durationMs: number }
  | {
      readonly status: 'failed';
      readonly kind: GateKind;
      readonly command: string;
      readonly exitCode: number;
      /** Uma frase para o usuario. A saida bruta vai em `detail`. */
      readonly summary: string;
      readonly detail: string;
      readonly durationMs: number;
    }
  | {
      readonly status: 'timeout';
      readonly kind: GateKind;
      readonly command: string;
      readonly summary: string;
      readonly detail: string;
      readonly durationMs: number;
    }
  ;

/**
 * Tudo que nao passou -- e tudo aqui e responsabilidade do trabalho entregue.
 * Copia que nem ficou pronta para ser conferida nao aparece nesta lista de
 * proposito: quem prepara e o `WorktreePreparer`, e cobrar do agente um
 * problema de ambiente seria manda-lo consertar o que ele nao quebrou.
 */
export type GateFailure = Exclude<GateResult, { status: 'passed' }>;

export interface GateRun {
  readonly gate: Gate;
  /** Onde rodar. No fim da execucao e o proprio repositorio, ja integrado. */
  readonly worktree: Worktree;
  readonly taskId: TaskId;
  /**
   * Variaveis extras. E por aqui que entra o cache de build compartilhado da
   * execucao: sem ele cada copia recomeca a compilacao do zero.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Executa o portao de verificacao na worktree do agente. Nenhum agente aprova
 * o proprio trabalho: quem decide se a subtask esta pronta e este comando,
 * rodado por fora, e o gerente so integra o que passou.
 */
export interface GateRunner {
  run(input: GateRun): Promise<GateResult>;
}

export interface CommandGateRunnerOptions {
  /** Quanto da saida bruta vai para `detail`. O resto e cortado pela frente. */
  readonly maxDetailChars?: number;
  /** Espera entre o pedido de parada e a morte do processo, no timeout. */
  readonly killGraceMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_DETAIL_CHARS = 8_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * O portao rodando de verdade: um comando do proprio projeto, na copia do
 * agente, com codigo de saida como unico criterio.
 *
 * Falhar nao e excecao -- e resposta, e vira uma frase que quem nao le codigo
 * entende, com a saida do compilador guardada em `detail`, atras de um clique.
 *
 * A copia ja chega pronta: quem instala dependencia e o `WorktreePreparer`,
 * antes de o agente comecar.
 */
export class CommandGateRunner implements GateRunner {
  constructor(private readonly options: CommandGateRunnerOptions = {}) {}

  async run({ gate, worktree, env }: GateRun): Promise<GateResult> {
    const started = Date.now();
    const result = await this.exec(gate.command, join(worktree.path, gate.cwd), gate.timeoutMs, env);
    const durationMs = Date.now() - started;
    const detail = tail(result.output, this.options.maxDetailChars ?? DEFAULT_DETAIL_CHARS);

    if (result.timedOut) {
      return {
        status: 'timeout',
        kind: gate.kind,
        command: gate.command,
        summary: `${GATE_SUBJECT[gate.kind]} passou de ${minutes(gate.timeoutMs)} e eu parei de esperar.`,
        detail,
        durationMs,
      };
    }
    if (result.code === 0) return { status: 'passed', durationMs };

    return {
      status: 'failed',
      kind: gate.kind,
      command: gate.command,
      exitCode: result.code,
      summary: summarize(gate.kind, result.output),
      detail,
      durationMs,
    };
  }

  private exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    extra: Readonly<Record<string, string>> | undefined,
  ): Promise<{ code: number; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        // Grupo proprio para o timeout conseguir matar a arvore inteira. Um
        // `pnpm build` vira turbo, que vira um `tsc` por pacote: matar so o
        // shell deixaria todos eles rodando na maquina de quem esta usando.
        detached: process.platform !== 'win32',
        // `CI` desliga modo interativo e watch: sem ele um `test` que fica
        // observando arquivo nunca sai, e o portao vira timeout em vez de
        // resposta. Sem cor porque a saida vai virar texto num painel.
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          ...this.options.env,
          ...extra,
        },
      });

      let output = '';
      let timedOut = false;
      let settled = false;
      const collect = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timers: NodeJS.Timeout[] = [];
      const later = (ms: number, action: () => void): void => {
        const timer = setTimeout(action, ms);
        timer.unref?.();
        timers.push(timer);
      };

      const settle = (code: number): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        resolve({ code, output, timedOut });
      };

      const stop = (signal: NodeJS.Signals): void => {
        const { pid } = child;
        if (pid === undefined) return;
        try {
          // Negativo e o grupo, nao o processo.
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // Ja morreu entre uma coisa e outra.
          }
        }
      };

      const grace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      later(timeoutMs, () => {
        timedOut = true;
        stop('SIGTERM');
        later(grace, () => stop('SIGKILL'));
        // O processo morto ainda segura a saida enquanto algum filho tiver o
        // descritor aberto, e ai `close` nunca chega. Depois do prazo o
        // veredito sai com o que ja foi lido: um portao nao pode pendurar a
        // execucao inteira esperando um comando que ele mesmo mandou parar.
        later(grace * 2, () => settle(-1));
      });

      // Sem shell, sem permissao, sem pasta: o portao nao rodou, e isso conta
      // como reprovado -- integrar sem ter verificado seria pior.
      child.on('error', (error: Error) => {
        output += `\n${error.message}`;
        settle(-1);
      });
      child.on('close', (code) => settle(code ?? -1));
    });
  }
}


/** Sujeito da frase, por tipo de portao. Sem jargao: e o que o usuario le. */
const GATE_SUBJECT: Record<GateKind, string> = {
  typecheck: 'A conferencia do codigo',
  build: 'A montagem do projeto',
  test: 'A bateria de testes',
  lint: 'A conferencia de padrao',
  custom: 'A verificacao do projeto',
};

const GATE_FAILURE: Record<GateKind, string> = {
  typecheck: 'O codigo entregue nao passou na conferencia do projeto',
  build: 'O projeto parou de montar depois desta mudanca',
  test: 'Os testes do projeto falharam depois desta mudanca',
  lint: 'O codigo entregue saiu do padrao que o projeto exige',
  custom: 'A verificacao do projeto reprovou o que foi entregue',
};

/**
 * A frase principal, sempre respondivel por quem nao le codigo. A contagem
 * entra so quando da para conta-la com confianca: "3 problemas" ajuda, e
 * "0 problemas" num portao vermelho confundiria.
 */
function summarize(kind: GateKind, output: string): string {
  const problems = countProblems(output);
  const base = GATE_FAILURE[kind];
  if (problems === 0) return `${base}.`;
  return `${base}: ${problems} ${problems === 1 ? 'problema apontado' : 'problemas apontados'}.`;
}

/** Linhas que a ferramenta marcou como erro. Heuristica, e por isso so conta. */
function countProblems(output: string): number {
  const marks = /(^|\s)(error|erro|failed|failing|✕|×|✗)(\b|:)/i;
  return output.split('\n').filter((line) => marks.test(line)).length;
}

/** O fim da saida e onde mora o resumo do erro em praticamente toda ferramenta. */
function tail(output: string, max: number): string {
  const trimmed = output.trim();
  if (trimmed.length <= max) return trimmed;
  return `[...saida cortada...]\n${trimmed.slice(trimmed.length - max)}`;
}

const minutes = (ms: number): string => {
  const total = Math.max(1, Math.round(ms / 60_000));
  return `${total} ${total === 1 ? 'minuto' : 'minutos'}`;
};
