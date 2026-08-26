import { z } from 'zod';

/**
 * Identificadores sao strings com marca de tipo. A marca existe para que o
 * compilador recuse passar um TaskId onde se espera um AgentId.
 */
const id = () => z.string().min(1).max(128);

export const runId = id().brand<'RunId'>();
export const eventId = id().brand<'EventId'>();
export const agentId = id().brand<'AgentId'>();
export const taskId = id().brand<'TaskId'>();
export const planId = id().brand<'PlanId'>();
export const gateId = id().brand<'GateId'>();
export const contractId = id().brand<'ContractId'>();
export const questionId = id().brand<'QuestionId'>();

export type RunId = z.infer<typeof runId>;
export type EventId = z.infer<typeof eventId>;
export type AgentId = z.infer<typeof agentId>;
export type TaskId = z.infer<typeof taskId>;
export type PlanId = z.infer<typeof planId>;
export type GateId = z.infer<typeof gateId>;
export type ContractId = z.infer<typeof contractId>;
export type QuestionId = z.infer<typeof questionId>;

const uuid = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const newRunId = (): RunId => runId.parse(`run_${uuid()}`);
export const newEventId = (): EventId => eventId.parse(`evt_${uuid()}`);
export const newAgentId = (role: string): AgentId => agentId.parse(`agt_${role}_${uuid().slice(0, 8)}`);
export const newTaskId = (): TaskId => taskId.parse(`tsk_${uuid().slice(0, 8)}`);
export const newPlanId = (): PlanId => planId.parse(`pln_${uuid().slice(0, 8)}`);
export const newGateId = (): GateId => gateId.parse(`gat_${uuid().slice(0, 8)}`);
export const newContractId = (): ContractId => contractId.parse(`ctr_${uuid().slice(0, 8)}`);
export const newQuestionId = (): QuestionId => questionId.parse(`qst_${uuid().slice(0, 8)}`);
