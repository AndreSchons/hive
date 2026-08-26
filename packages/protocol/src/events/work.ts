import { z } from 'zod';
import { agentId, taskId } from '../ids';

export const workEventPayloads = {
  'tool.call': z.object({
    agentId,
    taskId: taskId.optional(),
    /** Nome da ferramenta como a CLI reportou. */
    tool: z.string().min(1),
    target: z.string().optional(),
    summary: z.string().min(1).max(280),
  }),
  'file.changed': z.object({
    agentId,
    taskId: taskId.optional(),
    path: z.string().min(1),
    change: z.enum(['created', 'modified', 'deleted']),
    linesAdded: z.number().int().nonnegative().default(0),
    linesRemoved: z.number().int().nonnegative().default(0),
  }),
  'worktree.merged': z.object({
    agentId,
    taskId,
    branch: z.string().min(1),
    into: z.string().min(1),
    filesChanged: z.number().int().nonnegative(),
  }),
} as const;
