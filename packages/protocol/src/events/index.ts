import { z } from 'zod';
import { eventId, runId } from '../ids';
import { agentEventPayloads } from './agent';
import { gateEventPayloads } from './gate';
import { humanEventPayloads } from './human';
import { interactionEventPayloads } from './interaction';
import { limitEventPayloads } from './limits';
import { planEventPayloads } from './plan';
import { runEventPayloads } from './run';
import { taskEventPayloads } from './task';
import { workEventPayloads } from './work';

/** Versao do formato do envelope. Muda so em quebra incompativel. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Catalogo unico de eventos: cada chave e um tipo, cada valor o schema do seu
 * payload. Tudo daqui pra baixo (schemas de envelope e tipos TypeScript) e
 * derivado deste objeto -- nada e escrito duas vezes.
 */
export const eventPayloads = {
  ...runEventPayloads,
  ...planEventPayloads,
  ...agentEventPayloads,
  ...taskEventPayloads,
  ...gateEventPayloads,
  ...interactionEventPayloads,
  ...humanEventPayloads,
  ...workEventPayloads,
  ...limitEventPayloads,
} as const;

export type EventPayloadSchemas = typeof eventPayloads;
export type EventType = keyof EventPayloadSchemas & string;

/** Payload ja validado, com defaults aplicados. */
export type EventPayload<T extends EventType = EventType> = z.infer<EventPayloadSchemas[T]>;
/** Payload como se escreve na emissao: defaults ainda opcionais. */
export type EventPayloadInput<T extends EventType = EventType> = z.input<EventPayloadSchemas[T]>;

export const EVENT_TYPES = Object.keys(eventPayloads).sort() as EventType[];

export const isEventType = (value: unknown): value is EventType =>
  typeof value === 'string' && Object.hasOwn(eventPayloads, value);

/** Campos comuns a todo evento. Atribuidos pelo event store, nunca por quem emite. */
export const envelopeMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: eventId,
  runId,
  /** Monotonico e sem buracos dentro de uma execucao, comecando em 1. */
  seq: z.number().int().positive(),
  /** Epoch em milissegundos. */
  ts: z.number().int().nonnegative(),
});
export type EnvelopeMeta = z.infer<typeof envelopeMetaSchema>;

/** Evento completo de um tipo. */
const envelope = <T extends EventType>(type: T) =>
  envelopeMetaSchema.extend({ type: z.literal(type), payload: eventPayloads[type] });

/** Evento antes do append: sem id, sem seq, sem timestamp. */
const unsealed = <T extends EventType>(type: T) =>
  z.object({ type: z.literal(type), payload: eventPayloads[type] });

/**
 * A lista abaixo e a unica repeticao de nomes de evento no pacote, e existe
 * porque `z.discriminatedUnion` precisa de uma tupla literal para produzir a
 * uniao discriminada. `test/events.test.ts` compara esta lista com o catalogo
 * e falha se alguem adicionar um payload sem registrar aqui.
 */
export const eventSchema = z.discriminatedUnion('type', [
  envelope('run.started'),
  envelope('run.completed'),
  envelope('run.failed'),
  envelope('plan.created'),
  envelope('plan.revised'),
  envelope('contract.published'),
  envelope('agent.spawned'),
  envelope('agent.state_changed'),
  envelope('agent.despawned'),
  envelope('task.assigned'),
  envelope('task.started'),
  envelope('task.progress'),
  envelope('task.completed'),
  envelope('task.failed'),
  envelope('gate.started'),
  envelope('gate.passed'),
  envelope('gate.failed'),
  envelope('agent.message'),
  envelope('agent.handoff'),
  envelope('human.question_raised'),
  envelope('human.answered'),
  envelope('tool.call'),
  envelope('file.changed'),
  envelope('worktree.merged'),
  envelope('budget.warning'),
  envelope('budget.exceeded'),
  envelope('loop.detected'),
]);

export const eventDraftSchema = z.discriminatedUnion('type', [
  unsealed('run.started'),
  unsealed('run.completed'),
  unsealed('run.failed'),
  unsealed('plan.created'),
  unsealed('plan.revised'),
  unsealed('contract.published'),
  unsealed('agent.spawned'),
  unsealed('agent.state_changed'),
  unsealed('agent.despawned'),
  unsealed('task.assigned'),
  unsealed('task.started'),
  unsealed('task.progress'),
  unsealed('task.completed'),
  unsealed('task.failed'),
  unsealed('gate.started'),
  unsealed('gate.passed'),
  unsealed('gate.failed'),
  unsealed('agent.message'),
  unsealed('agent.handoff'),
  unsealed('human.question_raised'),
  unsealed('human.answered'),
  unsealed('tool.call'),
  unsealed('file.changed'),
  unsealed('worktree.merged'),
  unsealed('budget.warning'),
  unsealed('budget.exceeded'),
  unsealed('loop.detected'),
]);

/** Uniao discriminada por `type`: o switch do reducer fica exaustivo. */
export type AnyEvent = z.infer<typeof eventSchema>;
export type AnyEventDraft = z.infer<typeof eventDraftSchema>;

export type EventEnvelope<T extends EventType> = Extract<AnyEvent, { type: T }>;
export type EventDraft<T extends EventType> = Extract<AnyEventDraft, { type: T }>;

/**
 * Constroi um evento ainda sem envelope, validando o payload na hora.
 * Quem emite erra na emissao, nao no replay tres dias depois.
 */
export function draft<T extends EventType>(type: T, payload: EventPayloadInput<T>): AnyEventDraft {
  return eventDraftSchema.parse({ type, payload });
}

export function parseEvent(input: unknown): AnyEvent {
  return eventSchema.parse(input);
}

export function safeParseEvent(input: unknown): z.ZodSafeParseResult<AnyEvent> {
  return eventSchema.safeParse(input);
}

/** Tipos efetivamente registrados na uniao. Usado para detectar catalogo fora de sincronia. */
export const registeredEventTypes = (): EventType[] =>
  eventSchema.options.map((option) => option.shape.type.value).sort();
