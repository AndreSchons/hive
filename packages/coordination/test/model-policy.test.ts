import { describe, expect, it } from 'vitest';
import { rosterSchema, type GateKind, type RoleDefinition } from '@office/protocol';
import {
  DefaultModelPolicy,
  modelFor,
  shiftTier,
  type ModelRequest,
} from '../src/model-policy';

const policy = new DefaultModelPolicy();

const passo = (extra: Partial<ModelRequest['subtask']> = {}, dependents = 0): ModelRequest => ({
  subtask: {
    allowedPaths: [],
    inputContracts: [],
    gate: { kind: 'typecheck' as GateKind },
    ...extra,
  },
  dependents,
});

/** Nada aqui pode aparecer numa frase que a pessoa vai ler antes de aprovar. */
const JARGAO = /sonnet|opus|haiku|token|tier|model|allowedPaths|gate/i;

describe('o que decide o degrau', () => {
  /**
   * O passo que e base dos outros erra caro: o erro dele viaja para todos os
   * que vem depois, e refazer sai mais caro que ter feito bem da primeira vez.
   */
  it('passo do qual varios dependem vai no caprichado', () => {
    const recomendacao = policy.recommend(passo({ allowedPaths: ['src/a'] }, 3));
    expect(recomendacao.tier).toBe('caprichado');
    expect(recomendacao.reason).toContain('3 passos dependem');
  });

  it('passo com contrato de entrada nao vai no mais barato', () => {
    expect(policy.recommend(passo({ inputContracts: ['ctr_1'] })).tier).toBe('padrao');
  });

  it('passo cobrado por testes ou build nao vai no mais barato', () => {
    expect(policy.recommend(passo({ gate: { kind: 'test' } })).tier).toBe('padrao');
    expect(policy.recommend(passo({ gate: { kind: 'build' } })).tier).toBe('padrao');
  });

  it('passo que mexe numa area so, e mais nada, vai no economico', () => {
    const recomendacao = policy.recommend(passo({ allowedPaths: ['apps/hub/src/App.tsx'] }));
    expect(recomendacao.tier).toBe('economico');
    expect(recomendacao.reason).toBe('mexe numa area so');
  });

  it('varias areas sobem para o equilibrado', () => {
    expect(policy.recommend(passo({ allowedPaths: ['a', 'b', 'c'] })).tier).toBe('padrao');
  });

  it('sem area declarada nao da para dizer que e pequeno', () => {
    expect(policy.recommend(passo()).tier).toBe('padrao');
  });

  it('o motivo e sempre uma frase de gente', () => {
    const casos: ModelRequest[] = [
      passo({ allowedPaths: ['a'] }, 4),
      passo({ inputContracts: ['ctr_1'] }),
      passo({ gate: { kind: 'test' } }),
      passo({ allowedPaths: ['a', 'b'] }),
      passo({ allowedPaths: ['a'] }),
      passo(),
    ];
    for (const caso of casos) {
      const { reason } = policy.recommend(caso);
      expect(reason, reason).not.toMatch(JARGAO);
      expect(reason.length).toBeGreaterThan(5);
    }
  });
});

describe('a postura escolhida pela pessoa', () => {
  it('move a escada inteira um degrau', () => {
    expect(shiftTier('padrao', 'economico')).toBe('economico');
    expect(shiftTier('padrao', 'recomendado')).toBe('padrao');
    expect(shiftTier('padrao', 'caprichado')).toBe('caprichado');
  });

  it('nao sai das pontas: nao existe degrau abaixo do primeiro', () => {
    expect(shiftTier('economico', 'economico')).toBe('economico');
    expect(shiftTier('caprichado', 'caprichado')).toBe('caprichado');
  });
});

describe('do degrau ate o alias da CLI', () => {
  const [comEscada, semEscada] = rosterSchema.parse([
    {
      id: 'backend',
      title: 'Backend',
      adapter: 'claude',
      canDelegate: true,
      models: { economico: 'haiku', padrao: 'sonnet', caprichado: 'opus' },
    },
    { id: 'frontend', title: 'Frontend', adapter: 'kimi', canDelegate: false },
  ]) as [RoleDefinition, RoleDefinition];

  it('resolve pelo papel, que e quem conhece a CLI', () => {
    expect(modelFor(comEscada, 'economico')).toBe('haiku');
    expect(modelFor(comEscada, 'caprichado')).toBe('opus');
  });

  /**
   * Nao inventamos alias: um nome que a CLI nao conhece derruba a execucao
   * inteira, e os aliases de algumas CLIs saem do config do proprio usuario.
   */
  it('papel sem escada fica com o padrao da CLI, em vez de um alias chutado', () => {
    expect(modelFor(semEscada, 'caprichado')).toBeUndefined();
  });
});
