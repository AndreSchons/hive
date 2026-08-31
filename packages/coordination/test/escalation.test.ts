import { describe, expect, it } from 'vitest';
import { agentId, taskId, type AgentId, type TaskId } from '@hive/protocol';
import { DefaultEscalationPolicy, OPTION_RESOLVE, OPTION_RETRY, OPTION_STOP } from '../src/escalation';
import type { BlockCause, EscalationDecision, HumanQuestion } from '../src/escalation';
import type { GateFailure } from '../src/gate-runner';

const AGENTE: AgentId = agentId.parse('agt_teste_1');
const TASK: TaskId = taskId.parse('tsk_login');

const policy = new DefaultEscalationPolicy();

const decide = (cause: BlockCause, attempt = 1): EscalationDecision =>
  policy.decide({ agentId: AGENTE, taskId: TASK, cause, attempt });

const gateFailure = (): GateFailure => ({
  status: 'failed',
  kind: 'typecheck',
  command: 'pnpm typecheck',
  exitCode: 2,
  summary: 'O codigo entregue nao passou na conferencia do projeto: 3 problemas apontados.',
  detail: 'src/login.ts(3,10): error TS2339: Property "x" does not exist',
  durationMs: 4_000,
});

const gateTimeout = (): GateFailure => ({
  status: 'timeout',
  kind: 'test',
  command: 'pnpm test',
  summary: 'A bateria de testes passou de 5 minutos e eu parei de esperar.',
  detail: '(sem saida antes de eu parar de esperar)',
  durationMs: 300_000,
});

const ask = (decision: EscalationDecision): HumanQuestion => {
  if (decision.action !== 'ask') throw new Error(`esperava perguntar, veio "${decision.action}"`);
  return decision.question;
};

/** Nada disso pode aparecer numa frase que a pessoa vai ler. */
const JARGAO = /exit code|stack|TS\d{4}|stderr|branch|merge |commit|\bnull\b/i;

describe('portao vermelho', () => {
  it('a primeira falha vira correcao, nao pergunta: a pessoa nao precisa ser incomodada', () => {
    const decision = decide({ kind: 'gate_failed', result: gateFailure() });
    if (decision.action !== 'retry') throw new Error('esperava tentar de novo');

    // O pedido de correcao vai para o agente, e ai detalhe tecnico e o ponto.
    expect(decision.guidance).toContain('pnpm typecheck');
    expect(decision.guidance).toContain('TS2339');
  });

  /**
   * Sem esta frase o caminho mais curto para o portao ficar verde e apagar o
   * teste que reprovou -- e ai o portao para de significar qualquer coisa.
   */
  it('proibe explicitamente desligar a verificacao para passar', () => {
    const decision = decide({ kind: 'gate_failed', result: gateFailure() });
    if (decision.action !== 'retry') throw new Error('esperava tentar de novo');
    expect(decision.guidance).toMatch(/nao apague nem desative/i);
  });

  it('a segunda falha sobe: insistir uma terceira vez so repetiria a segunda', () => {
    const question = ask(decide({ kind: 'gate_failed', result: gateFailure() }, 2));

    expect(question.cause).toBe('gate_failed');
    expect(question.question).not.toMatch(JARGAO);
    expect(question.context).not.toMatch(JARGAO);
    expect(question.options.map((option) => option.id)).toEqual([OPTION_RETRY, OPTION_STOP]);
    // Quem conhece o projeto costuma saber a pista que faltava.
    expect(question.allowFreeText).toBe(true);
  });

  it('a pergunta leva junto o que dizer ao agente se a pessoa mandar continuar', () => {
    const decision = decide({ kind: 'gate_failed', result: gateFailure() }, 2);
    if (decision.action !== 'ask') throw new Error('esperava perguntar');
    expect(decision.guidance).toContain('pnpm typecheck');
    expect(decision.onAnswer).toBe('restart');
  });

  it('o portao que nem chegou a terminar tambem sobe como pergunta', () => {
    const question = ask(decide({ kind: 'gate_failed', result: gateTimeout() }, 2));
    expect(question.cause).toBe('gate_failed');
    expect(question.context).toContain('parei de esperar');
  });
});

describe('duvida do agente', () => {
  it('sobe a pergunta como ele fez: quem sabe o que falta e ele', () => {
    const decision = decide({
      kind: 'agent_asked',
      question: 'O botao de entrar deve levar para a lista ou para o painel?',
      context: 'As duas telas existem e nenhuma esta marcada como inicial.',
    });
    if (decision.action !== 'ask') throw new Error('esperava perguntar');

    expect(decision.question.question).toBe('O botao de entrar deve levar para a lista ou para o painel?');
    expect(decision.question.cause).toBe('agent_asked');
    expect(decision.question.options).toEqual([]);
    expect(decision.question.allowFreeText).toBe(true);
    // A resposta volta para a mesma conversa, nao para uma tentativa nova.
    expect(decision.onAnswer).toBe('session');
  });

  it('nunca tenta de novo sozinho: chutar aqui entrega a coisa errada', () => {
    const decision = decide(
      { kind: 'agent_asked', question: 'Azul ou verde?', context: 'Nao esta escrito.' },
      5,
    );
    expect(decision.action).toBe('ask');
  });
});

describe('limite estourado', () => {
  it('pergunta em vez de seguir tentando as cegas', () => {
    const question = ask(
      decide({ kind: 'budget', verdict: { status: 'exceeded', kind: 'turns', used: 30, limit: 30 } }),
    );
    expect(question.cause).toBe('budget');
    expect(question.context).toContain('30 tentativas');
    expect(question.question).not.toMatch(JARGAO);
  });

  it('a repeticao vira frase, nao assinatura de ferramenta', () => {
    const question = ask(
      decide({ kind: 'budget', verdict: { status: 'looping', signature: 'Bash:pnpm test', occurrences: 4 } }),
    );
    expect(question.context).toContain('4 vezes');
    expect(question.context).not.toContain('Bash:');
  });

  it('tempo estourado fala em minutos, nao em milissegundos', () => {
    const question = ask(
      decide({ kind: 'budget', verdict: { status: 'exceeded', kind: 'time', used: 900_000, limit: 900_000 } }),
    );
    expect(question.context).toContain('15 minutos');
  });
});

describe('agente que caiu', () => {
  it('a primeira queda vira outra tentativa: quase sempre e passageiro', () => {
    const decision = decide({ kind: 'agent_crashed', reason: 'A CLI encerrou sem terminar.' });
    expect(decision.action).toBe('retry');
  });

  it('a segunda queda sobe, com o motivo em linguagem de gente', () => {
    const question = ask(
      decide({ kind: 'agent_crashed', reason: 'A CLI encerrou sem terminar.' }, 2),
    );
    expect(question.cause).toBe('agent_crashed');
    expect(question.context).toBe('A CLI encerrou sem terminar.');
  });
});

describe('conflito', () => {
  it('nunca resolve sozinho: para, pergunta, e da a decisao a pessoa', () => {
    const decision = decide({ kind: 'merge_conflict', files: ['src/login.ts', 'src/app.ts'] });
    if (decision.action !== 'ask') throw new Error('esperava perguntar');

    expect(decision.question.options.map((option) => option.id)).toEqual([OPTION_RESOLVE, OPTION_STOP]);
    expect(decision.question.context).toContain('src/login.ts');
    expect(decision.question.question).not.toMatch(JARGAO);
    expect(decision.onAnswer).toBe('resolve');
  });
});

describe('quantas tentativas', () => {
  it('e configuravel, e o limite vale para todo motivo que aceita retry', () => {
    const paciente = new DefaultEscalationPolicy({ maxAttempts: 3 });
    const cause: BlockCause = { kind: 'gate_failed', result: gateFailure() };

    expect(paciente.decide({ agentId: AGENTE, cause, attempt: 2 }).action).toBe('retry');
    expect(paciente.decide({ agentId: AGENTE, cause, attempt: 3 }).action).toBe('ask');
  });

  it('cada pergunta ganha um id proprio', () => {
    const cause: BlockCause = { kind: 'gate_failed', result: gateFailure() };
    const um = ask(decide(cause, 2));
    const dois = ask(decide(cause, 2));
    expect(um.questionId).not.toBe(dois.questionId);
  });
});
