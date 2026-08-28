import { z } from 'zod';
import { questionId, runId } from './ids';
import { roleId, rosterSchema } from './roles';

/** Uma pasta de projeto ja escolhida pelo usuario. */
export const projectRefSchema = z.object({
  path: z.string().min(1),
  /** Nome exibido: o basename da pasta. */
  name: z.string().min(1),
  lastOpenedAt: z.number().int().nonnegative(),
  /** Falso quando a pasta sumiu do disco entre uma sessao e outra. */
  exists: z.boolean().default(true),
});
export type ProjectRef = z.infer<typeof projectRefSchema>;

export const runSummarySchema = z.object({
  runId,
  projectPath: z.string().min(1),
  goal: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  eventCount: z.number().int().nonnegative(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

/**
 * Comandos que o renderer envia ao processo principal. Cada entrada declara o
 * schema da entrada e o da saida; a ponte IPC deriva os tipos daqui, entao
 * renderer e main nao podem discordar sobre um canal.
 */
export const commands = {
  'project.pick': {
    input: z.object({}),
    /** null quando o usuario fecha o dialogo nativo sem escolher. */
    output: projectRefSchema.nullable(),
  },
  'project.open': {
    input: z.object({ path: z.string().min(1) }),
    output: projectRefSchema,
  },
  'project.recent': {
    input: z.object({ limit: z.number().int().positive().max(50).default(10) }),
    output: z.array(projectRefSchema),
  },
  'project.forget': {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  'roster.get': {
    input: z.object({}),
    output: rosterSchema,
  },
  /**
   * Duas formas de comecar, uma uniao so. Ou a pessoa monta a fila e diz quem
   * faz o que (`queue`), ou descreve o objetivo e o gerente divide (`planned`).
   * Uniao discriminada em vez de dois campos opcionais: nao sobra jeito de
   * pedir as duas coisas ao mesmo tempo, nem nenhuma.
   */
  'run.start': {
    input: z.object({
      projectPath: z.string().min(1),
      request: z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('queue'),
          tasks: z
            .array(z.object({ goal: z.string().min(1), role: roleId }))
            .min(1)
            .max(8),
        }),
        z.object({ mode: z.literal('planned'), goal: z.string().min(1) }),
      ]),
    }),
    output: z.object({ runId }),
  },
  'run.cancel': {
    input: z.object({ runId }),
    output: z.object({ cancelled: z.boolean() }),
  },
  'run.list': {
    input: z.object({ projectPath: z.string().min(1), limit: z.number().int().positive().max(200).default(50) }),
    output: z.array(runSummarySchema),
  },
  /** Backfill: tudo que aconteceu numa execucao a partir de um seq. */
  'run.events': {
    input: z.object({ runId, afterSeq: z.number().int().nonnegative().default(0) }),
    output: z.array(z.unknown()),
  },
  'human.answer': {
    input: z.object({ runId, questionId, answer: z.string().min(1), optionId: z.string().min(1).optional() }),
    output: z.object({ accepted: z.boolean() }),
  },
  /** Dispara o simulador roteirizado. Existe so enquanto nao ha agente real. */
  'dev.simulate': {
    input: z.object({ projectPath: z.string().min(1), goal: z.string().min(1).default('Execucao simulada') }),
    output: z.object({ runId }),
  },
} as const;

export type Commands = typeof commands;
export type CommandName = keyof Commands & string;

export type CommandInput<N extends CommandName> = z.input<Commands[N]['input']>;
export type CommandArgs<N extends CommandName> = z.infer<Commands[N]['input']>;
export type CommandResult<N extends CommandName> = z.infer<Commands[N]['output']>;

export const isCommandName = (value: unknown): value is CommandName =>
  typeof value === 'string' && Object.hasOwn(commands, value);

/** `Object.keys` devolve `string[]`; o proprio guard e quem estreita. */
export const COMMAND_NAMES: CommandName[] = Object.keys(commands).filter(isCommandName).sort();
