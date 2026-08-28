import { describe, expect, it } from 'vitest';
import {
  newAgentId,
  newGateId,
  newPlanId,
  newRunId,
  planSchema,
  rosterSchema,
  type Plan,
} from '@office/protocol';
import { checkPlan } from '../src/index';

const ROSTER = rosterSchema.parse([
  { id: 'gerente', title: 'Gerente', adapter: 'claude', canDelegate: true },
  { id: 'backend', title: 'Backend', adapter: 'claude' },
  { id: 'frontend', title: 'Interface', adapter: 'kimi' },
]);

const GATES = [
  { kind: 'typecheck' as const, command: 'pnpm typecheck' },
  { kind: 'test' as const, command: 'pnpm test' },
];

function subtask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    description: `faz ${id}`,
    role: 'backend',
    doneWhen: 'passa',
    gate: { id: newGateId(), kind: 'typecheck', command: 'pnpm typecheck' },
    budget: {},
    ...overrides,
  };
}

const build = (subtasks: unknown[], contracts: unknown[] = []): Plan =>
  planSchema.parse({
    id: newPlanId(),
    runId: newRunId(),
    createdBy: newAgentId('gerente'),
    goal: 'um objetivo',
    subtasks,
    contracts,
  });

const check = (plan: Plan) => checkPlan({ plan, roster: ROSTER, gates: GATES });

describe('checkPlan', () => {
  it('mede tamanho, profundidade e primeira leva', () => {
    const report = check(
      build([
        subtask('a', { allowedPaths: ['src/a'] }),
        subtask('b', { allowedPaths: ['src/b'] }),
        subtask('c', { dependsOn: ['a', 'b'], allowedPaths: ['src/c'] }),
      ]),
    );
    expect(report.subtasks).toBe(3);
    expect(report.depth).toBe(2);
    expect(report.firstWave).toBe(2);
    expect(report.findings).toEqual([]);
  });

  it('acusa papel que nao existe no roster', () => {
    const report = check(build([subtask('a', { role: 'devops', allowedPaths: ['src/a'] })]));
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: 'erro', message: expect.stringContaining('devops') }),
    );
  });

  it('acusa portao inventado, que so quebraria na hora de verificar', () => {
    const report = check(
      build([
        subtask('a', {
          allowedPaths: ['src/a'],
          gate: { id: newGateId(), kind: 'custom', command: 'npm run check' },
        }),
      ]),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('npm run check') }),
    );
  });

  it('acusa duas subtasks paralelas dividindo o mesmo caminho', () => {
    // O preditor direto do conflito de merge: elas podem rodar juntas e mexem
    // no mesmo lugar.
    const report = check(
      build([
        subtask('a', { allowedPaths: ['apps/hub/src'] }),
        subtask('b', { allowedPaths: ['apps/hub/src/world'] }),
      ]),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('nao dependem uma da outra') }),
    );
  });

  it('nao acusa caminho compartilhado quando uma depende da outra', () => {
    // Em sequencia nunca colidem: uma so comeca depois que a outra integrou.
    const report = check(
      build([
        subtask('a', { allowedPaths: ['apps/hub/src'] }),
        subtask('b', { dependsOn: ['a'], allowedPaths: ['apps/hub/src'] }),
      ]),
    );
    expect(report.findings).toEqual([]);
  });

  it('enxerga dependencia indireta, nao so a direta', () => {
    const report = check(
      build([
        subtask('a', { allowedPaths: ['src/x'] }),
        subtask('b', { dependsOn: ['a'], allowedPaths: ['src/meio'] }),
        subtask('c', { dependsOn: ['b'], allowedPaths: ['src/x'] }),
      ]),
    );
    expect(report.findings).toEqual([]);
  });

  it('avisa quando ninguem declarou onde mexe', () => {
    const report = check(build([subtask('a'), subtask('b')]));
    expect(report.findings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('sem allowedPaths') }),
    );
  });

  it('avisa contrato publicado que ninguem usa', () => {
    const report = check(
      build(
        [subtask('a', { allowedPaths: ['src/a'] })],
        [{ id: 'sobrou', kind: 'types', title: 'Sobrou', body: 'nada' }],
      ),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('sobrou') }),
    );
  });
});
