import { describe, expect, it } from 'vitest';
import { agentId, budgetSchema, type AgentId, type Budget } from '@office/protocol';
import { InMemoryBudgetTracker } from '../src/budget';

const AGENTE: AgentId = agentId.parse('agt_teste_1');

const budget = (extra: Partial<Budget> = {}): Budget => budgetSchema.parse(extra);

/** Um relogio que so anda quando o teste manda: tempo nao se espera, se declara. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

describe('turnos', () => {
  it('avisa antes de estourar e so depois estoura', () => {
    const tracker = new InMemoryBudgetTracker();
    tracker.start(AGENTE, budget({ maxTurns: 10 }));

    // Os sete primeiros passam sem ruido: aviso cedo demais e ruido.
    for (let i = 0; i < 7; i += 1) {
      expect(tracker.record(AGENTE, `Edit:arquivo-${i}.ts`).status).toBe('ok');
    }
    expect(tracker.record(AGENTE, 'Edit:oitavo.ts')).toMatchObject({
      status: 'warning', kind: 'turns', used: 8, limit: 10,
    });
    // O aviso sai uma vez so: repetido, para de ser aviso.
    expect(tracker.record(AGENTE, 'Edit:nono.ts').status).toBe('ok');
    expect(tracker.record(AGENTE, 'Edit:decimo.ts')).toMatchObject({
      status: 'exceeded', kind: 'turns', used: 10, limit: 10,
    });
  });

  it('agente sem orcamento aberto nao tem teto a cobrar', () => {
    const tracker = new InMemoryBudgetTracker();
    expect(tracker.record(AGENTE, 'Edit:x.ts').status).toBe('ok');
    expect(tracker.usage(AGENTE)).toBeNull();
  });
});

describe('repeticao', () => {
  it('declara laco quando a mesma acao passa do tolerado', () => {
    const tracker = new InMemoryBudgetTracker();
    tracker.start(AGENTE, budget({ maxRepeats: 2 }));

    expect(tracker.record(AGENTE, 'Bash:pnpm test').status).toBe('ok');
    expect(tracker.record(AGENTE, 'Bash:pnpm test').status).toBe('ok');
    expect(tracker.record(AGENTE, 'Bash:pnpm test')).toMatchObject({
      status: 'looping', signature: 'Bash:pnpm test', occurrences: 3,
    });
  });

  it('acao diferente no meio zera a contagem: variar e sinal de progresso', () => {
    const tracker = new InMemoryBudgetTracker();
    tracker.start(AGENTE, budget({ maxRepeats: 2 }));

    tracker.record(AGENTE, 'Bash:pnpm test');
    tracker.record(AGENTE, 'Bash:pnpm test');
    tracker.record(AGENTE, 'Edit:src/login.ts');
    expect(tracker.record(AGENTE, 'Bash:pnpm test').status).toBe('ok');
  });

  it('nao repete o mesmo laco: quem coordena ja parou na primeira vez', () => {
    const tracker = new InMemoryBudgetTracker();
    tracker.start(AGENTE, budget({ maxRepeats: 1 }));

    tracker.record(AGENTE, 'Read:x.ts');
    expect(tracker.record(AGENTE, 'Read:x.ts').status).toBe('looping');
    expect(tracker.record(AGENTE, 'Read:x.ts').status).toBe('ok');
  });
});

describe('tempo', () => {
  it('estoura pelo relogio mesmo com poucos turnos', () => {
    const relogio = clock();
    const tracker = new InMemoryBudgetTracker(relogio.now);
    tracker.start(AGENTE, budget({ maxDurationMs: 60_000 }));

    relogio.advance(50_000);
    expect(tracker.record(AGENTE, 'Read:a.ts')).toMatchObject({ status: 'warning', kind: 'time' });
    relogio.advance(11_000);
    expect(tracker.record(AGENTE, 'Read:b.ts')).toMatchObject({ status: 'exceeded', kind: 'time' });
  });

  it('o agente parado tambem estoura, sem precisar gastar turno', () => {
    const relogio = clock();
    const tracker = new InMemoryBudgetTracker(relogio.now);
    tracker.start(AGENTE, budget({ maxDurationMs: 60_000 }));

    expect(tracker.check(AGENTE).status).toBe('ok');
    relogio.advance(61_000);
    expect(tracker.check(AGENTE)).toMatchObject({ status: 'exceeded', kind: 'time' });
  });
});

/**
 * O que impede "trinta turnos" de virar "trinta turnos por tentativa". Sem
 * isto uma subtask que tenta tres vezes teria tres orcamentos cheios, e o
 * limite deixaria de ser limite.
 */
describe('o que sobra para a proxima tentativa', () => {
  it('desconta o que ja foi gasto', () => {
    const relogio = clock();
    const tracker = new InMemoryBudgetTracker(relogio.now);
    tracker.start(AGENTE, budget({ maxTurns: 30, maxDurationMs: 900_000 }));

    for (let i = 0; i < 12; i += 1) tracker.record(AGENTE, `Edit:${i}.ts`);
    relogio.advance(300_000);

    const sobra = tracker.remaining(AGENTE);
    expect(sobra.maxTurns).toBe(18);
    expect(sobra.maxDurationMs).toBe(600_000);
  });

  it('nunca chega a zero: orcamento zerado pareceria agente quebrado', () => {
    const tracker = new InMemoryBudgetTracker();
    tracker.start(AGENTE, budget({ maxTurns: 2 }));
    for (let i = 0; i < 9; i += 1) tracker.record(AGENTE, `Edit:${i}.ts`);

    expect(tracker.remaining(AGENTE).maxTurns).toBe(1);
  });

  it('liberar apaga o registro do agente', () => {
    const tracker = new InMemoryBudgetTracker();
    tracker.start(AGENTE, budget());
    tracker.record(AGENTE, 'Edit:x.ts');
    expect(tracker.usage(AGENTE)?.turns).toBe(1);

    tracker.release(AGENTE);
    expect(tracker.usage(AGENTE)).toBeNull();
  });
});
