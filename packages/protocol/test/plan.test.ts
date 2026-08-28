import { describe, expect, it } from 'vitest';
import {
  findCycle,
  planDraftSchema,
  planJsonSchema,
  newAgentId,
  newContractId,
  newGateId,
  newPlanId,
  newRunId,
  planSchema,
  readySubtasks,
  type Plan,
} from '../src/index';

const manager = newAgentId('gerente');

function subtask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Subtask ${id}`,
    description: `Faca ${id}`,
    role: 'backend',
    doneWhen: 'o portao passa',
    gate: { id: newGateId(), kind: 'typecheck', command: 'pnpm typecheck' },
    budget: {},
    ...overrides,
  };
}

function plan(subtasks: unknown[], contracts: unknown[] = []) {
  return {
    id: newPlanId(),
    runId: newRunId(),
    createdBy: manager,
    goal: 'Entregar a tela de login',
    subtasks,
    contracts,
  };
}

describe('planSchema', () => {
  it('aplica os defaults declarados', () => {
    const parsed: Plan = planSchema.parse(plan([subtask('a')]));
    const first = parsed.subtasks[0];
    expect(first).toBeDefined();
    expect(first?.dependsOn).toEqual([]);
    expect(first?.budget.maxTurns).toBe(30);
    expect(first?.gate.cwd).toBe('.');
    expect(parsed.revision).toBe(0);
  });

  it('recusa dependencia para subtask inexistente', () => {
    const result = planSchema.safeParse(plan([subtask('a', { dependsOn: ['fantasma'] })]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('dependencia inexistente');
  });

  it('recusa subtask que depende de si mesma', () => {
    const result = planSchema.safeParse(plan([subtask('a', { dependsOn: ['a'] })]));
    expect(result.success).toBe(false);
  });

  it('recusa ciclo entre subtasks', () => {
    const result = planSchema.safeParse(
      plan([subtask('a', { dependsOn: ['b'] }), subtask('b', { dependsOn: ['a'] })]),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes('ciclo'))).toBe(true);
  });

  it('recusa ids de subtask duplicados', () => {
    const result = planSchema.safeParse(plan([subtask('a'), subtask('a')]));
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes('duplicada'))).toBe(true);
  });

  it('exige que o contrato consumido tenha sido publicado no plano', () => {
    const orphan = newContractId();
    const result = planSchema.safeParse(plan([subtask('a', { inputContracts: [orphan] })]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('contrato nao publicado');
  });

  it('aceita contrato publicado como input de subtask paralela', () => {
    const id = newContractId();
    const contract = { id, kind: 'types', title: 'API de sessao', body: 'type Session = ...' };
    const result = planSchema.safeParse(
      plan([subtask('a', { inputContracts: [id] }), subtask('b', { inputContracts: [id] })], [contract]),
    );
    expect(result.success).toBe(true);
  });

  it('exige ao menos uma subtask', () => {
    expect(planSchema.safeParse(plan([])).success).toBe(false);
  });
});

describe('findCycle', () => {
  it('devolve null em grafo acilico', () => {
    expect(findCycle([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }])).toBeNull();
  });

  it('encontra ciclo indireto', () => {
    const cycle = findCycle([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['c'] },
      { id: 'c', dependsOn: ['a'] },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle?.length).toBeGreaterThan(3);
  });
});

describe('readySubtasks', () => {
  it('libera so o que tem dependencias satisfeitas', () => {
    const parsed = planSchema.parse(
      plan([subtask('a'), subtask('b', { dependsOn: ['a'] }), subtask('c', { dependsOn: ['a'] })]),
    );

    expect(readySubtasks(parsed, new Set()).map((s) => s.id)).toEqual(['a']);
    expect(readySubtasks(parsed, new Set(['a'])).map((s) => s.id)).toEqual(['b', 'c']);
    expect(readySubtasks(parsed, new Set(['a', 'b', 'c']))).toEqual([]);
  });
});

describe('planDraftSchema', () => {
  /** O rascunho do modelo: sem id de portao e sem orcamento. */
  function rascunho(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      title: `Subtask ${id}`,
      description: `Faca ${id}`,
      role: 'backend',
      doneWhen: 'o portao passa',
      gate: { kind: 'typecheck', command: 'pnpm typecheck' },
      ...overrides,
    };
  }

  it('aceita id em slug, que e o que o modelo escreve', () => {
    const parsed = planDraftSchema.parse({
      subtasks: [rascunho('schema-do-login'), rascunho('tela-do-login', { dependsOn: ['schema-do-login'] })],
    });
    expect(parsed.subtasks.map((subtask) => subtask.id)).toEqual(['schema-do-login', 'tela-do-login']);
  });

  it('recusa ciclo no rascunho, com a mesma regra do plano completo', () => {
    const result = planDraftSchema.safeParse({
      subtasks: [
        rascunho('a', { dependsOn: ['b'] }),
        rascunho('b', { dependsOn: ['a'] }),
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('ciclo de dependencias');
  });

  it('recusa contrato citado mas nao publicado', () => {
    const result = planDraftSchema.safeParse({
      subtasks: [rascunho('a', { inputContracts: ['contrato-que-nao-existe'] })],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('contrato nao publicado');
  });

  it('nao deixa o modelo escolher o proprio orcamento', () => {
    const parsed = planDraftSchema.parse({
      subtasks: [rascunho('a', { budget: { maxTurns: 9999 } })],
    });
    // Orcamento e limite duro do sistema: some do rascunho em vez de valer.
    expect(parsed.subtasks[0]).not.toHaveProperty('budget');
  });

  it('gera o JSON Schema que vai no prompt, a partir do mesmo Zod', () => {
    const schema = planJsonSchema();
    const subtask = (schema['properties'] as Record<string, { items: Record<string, unknown> }>)['subtasks']
      ?.items;
    // O modelo preenche isto; id de portao, orcamento e runId sao do sistema.
    expect(subtask?.['required']).toEqual(['id', 'title', 'description', 'role', 'doneWhen', 'gate']);
  });
});
