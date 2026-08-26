import { z } from 'zod';
import { agentId, taskId } from '../ids';
import { roleId } from '../roles';

export const taskEventPayloads = {
  'task.assigned': z.object({
    taskId,
    title: z.string().min(1),
    role: roleId,
    /** Quem atribuiu e para quem: o 3D precisa dos dois para animar a entrega. */
    assignedBy: agentId,
    assignedTo: agentId,
    dependsOn: z.array(taskId).default([]),
  }),
  'task.started': z.object({ taskId, agentId, title: z.string().min(1) }),
  'task.progress': z.object({
    taskId,
    agentId,
    note: z.string().min(1),
    ratio: z.number().min(0).max(1).optional(),
  }),
  'task.completed': z.object({
    taskId,
    agentId,
    summary: z.string().min(1),
    filesChanged: z.number().int().nonnegative().default(0),
  }),
  'task.failed': z.object({
    taskId,
    agentId,
    reason: z.string().min(1),
    detail: z.string().optional(),
  }),
} as const;
