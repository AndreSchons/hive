import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  SCHEMA_VERSION,
  draft,
  eventPayloads,
  isEventType,
  newAgentId,
  newEventId,
  newQuestionId,
  newRunId,
  newTaskId,
  parseEvent,
  registeredEventTypes,
  safeParseEvent,
  type AnyEvent,
} from '../src/index';

const envelope = (type: string, payload: unknown, seq = 1) => ({
  schemaVersion: SCHEMA_VERSION,
  id: newEventId(),
  runId: newRunId(),
  seq,
  ts: Date.now(),
  type,
  payload,
});

describe('catalogo de eventos', () => {
  it('cobre todos os dominios previstos no contrato', () => {
    for (const type of [
      'run.started',
      'run.completed',
      'run.failed',
      'plan.created',
      'plan.revised',
      'contract.published',
      'agent.spawned',
      'agent.state_changed',
      'agent.despawned',
      'task.assigned',
      'task.started',
      'task.progress',
      'task.completed',
      'task.failed',
      'gate.started',
      'gate.passed',
      'gate.failed',
      'agent.message',
      'agent.handoff',
      'human.question_raised',
      'human.answered',
      'tool.call',
      'file.changed',
      'worktree.merged',
      'budget.warning',
      'budget.exceeded',
      'loop.detected',
    ]) {
      expect(EVENT_TYPES, `${type} ausente do catalogo`).toContain(type);
    }
  });

  it('nao tem tipo sem schema de payload', () => {
    for (const type of EVENT_TYPES) {
      expect(eventPayloads[type]).toBeDefined();
    }
  });

  it('mantem a uniao discriminada em sincronia com o catalogo', () => {
    // Guarda contra o unico ponto de repeticao do pacote: um payload novo em
    // events/*.ts que ninguem registrou na tupla de `eventSchema`.
    expect(registeredEventTypes()).toEqual(EVENT_TYPES);
  });

  it('reconhece apenas tipos do catalogo', () => {
    expect(isEventType('run.started')).toBe(true);
    expect(isEventType('run.exploded')).toBe(false);
    expect(isEventType(42)).toBe(false);
  });
});

describe('draft', () => {
  it('aplica defaults do payload na emissao', () => {
    const event = draft('file.changed', {
      agentId: newAgentId('backend'),
      path: 'src/index.ts',
      change: 'modified',
    });
    expect(event.type).toBe('file.changed');
    if (event.type !== 'file.changed') throw new Error('tipo inesperado');
    expect(event.payload.linesAdded).toBe(0);
    expect(event.payload.linesRemoved).toBe(0);
  });

  it('recusa payload de outro tipo de evento', () => {
    expect(() => draft('run.completed', { summary: 'ok', durationMs: 1, tasksCompleted: 0 })).not.toThrow();
    // @ts-expect-error payload de `run.started` nao pertence a `run.completed`
    expect(() => draft('run.completed', { projectPath: '/tmp', goal: 'x', startedBy: 'human' })).toThrow();
  });

  it('falha na emissao quando o payload esta errado', () => {
    expect(() => draft('run.failed', { reason: '' })).toThrow();
  });
});

describe('parseEvent', () => {
  it('valida um envelope completo', () => {
    const agent = newAgentId('gerente');
    const event: AnyEvent = parseEvent(
      envelope('task.assigned', {
        taskId: newTaskId(),
        title: 'Criar a rota de login',
        role: 'backend',
        assignedBy: agent,
        assignedTo: newAgentId('backend'),
      }),
    );

    expect(event.type).toBe('task.assigned');
    if (event.type === 'task.assigned') {
      expect(event.payload.assignedBy).toBe(agent);
      expect(event.payload.dependsOn).toEqual([]);
    }
  });

  it('recusa tipo desconhecido apontando o campo type', () => {
    const result = safeParseEvent(envelope('run.exploded', {}));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['type']);
  });

  it('reporta erro de payload sob o caminho payload.*', () => {
    const result = safeParseEvent(envelope('agent.state_changed', { agentId: newAgentId('x'), from: 'idle', to: 'dancando' }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['payload', 'to']);
  });

  it('recusa seq zero ou negativo', () => {
    const payload = { projectPath: '/tmp/p', goal: 'x', startedBy: 'human' };
    expect(safeParseEvent(envelope('run.started', payload, 0)).success).toBe(false);
    expect(safeParseEvent(envelope('run.started', payload, 1)).success).toBe(true);
  });

  it('preserva a pergunta ao humano com suas opcoes', () => {
    const event = parseEvent(
      envelope('human.question_raised', {
        questionId: newQuestionId(),
        question: 'O login deve aceitar conta do Google?',
        context: 'O time precisa disso para escolher a biblioteca de autenticacao.',
        options: [
          { id: 'sim', label: 'Sim, aceitar Google' },
          { id: 'nao', label: 'Nao, so email e senha' },
        ],
      }),
    );

    expect(event.type).toBe('human.question_raised');
    if (event.type === 'human.question_raised') {
      expect(event.payload.options).toHaveLength(2);
      expect(event.payload.allowFreeText).toBe(true);
    }
  });
});
