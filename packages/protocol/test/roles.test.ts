import { describe, expect, it } from 'vitest';
import { rosterSchema, roleId, adapterId, agentStateSchema } from '../src/index';

const role = (id: string, canDelegate = false) => ({
  id,
  title: id,
  adapter: 'claude',
  canDelegate,
});

describe('rosterSchema', () => {
  it('aceita um roster com um papel que delega', () => {
    const parsed = rosterSchema.parse([role('gerente', true), role('frontend')]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.description).toBe('');
  });

  it('recusa roster sem nenhum papel capaz de delegar', () => {
    const result = rosterSchema.safeParse([role('frontend'), role('backend')]);
    expect(result.success).toBe(false);
  });

  it('recusa papel duplicado', () => {
    const result = rosterSchema.safeParse([role('gerente', true), role('gerente')]);
    expect(result.success).toBe(false);
  });

  it('recusa roster vazio', () => {
    expect(rosterSchema.safeParse([]).success).toBe(false);
  });
});

describe('identificadores de configuracao', () => {
  it('exige kebab-case em papel e adaptador', () => {
    expect(roleId.safeParse('frontend-3d').success).toBe(true);
    expect(roleId.safeParse('Frontend').success).toBe(false);
    expect(roleId.safeParse('3d').success).toBe(false);
    expect(adapterId.safeParse('mock').success).toBe(true);
    expect(adapterId.safeParse('claude_code').success).toBe(false);
  });

  it('fixa os seis estados que o mundo 3D anima', () => {
    expect(agentStateSchema.options).toEqual(['idle', 'thinking', 'working', 'blocked', 'talking', 'done']);
  });
});
