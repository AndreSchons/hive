import type { AgentState } from '@office/protocol';
import { STATE_LABEL } from '../state/describe';
import type { AgentView, TaskView } from '../state/event-reducer';

const STATE_DOT: Record<AgentState, string> = {
  idle: 'bg-muted',
  thinking: 'bg-accent animate-pulse',
  working: 'bg-good',
  blocked: 'bg-bad',
  talking: 'bg-ask',
  done: 'bg-muted/50',
};

export interface AgentListProps {
  readonly agents: readonly AgentView[];
  readonly tasks: Readonly<Record<string, TaskView>>;
}

export function AgentList({ agents, tasks }: AgentListProps) {
  if (agents.length === 0) {
    return <p className="px-4 py-4 text-sm text-muted">O escritorio esta vazio.</p>;
  }

  return (
    <ul className="flex flex-col gap-2 px-3 py-3">
      {agents.map((agent) => {
        const task = agent.currentTaskId === null ? null : tasks[agent.currentTaskId];
        return (
          <li
            key={agent.agentId}
            className={`rounded-lg border border-edge bg-panel px-3 py-2 ${agent.present ? '' : 'opacity-45'}`}
          >
            <div className="flex items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[agent.state]}`} />
              <span className="truncate text-sm font-medium">{agent.displayName}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted">{STATE_LABEL[agent.state]}</span>
            </div>

            <p className="mt-1 truncate text-xs text-muted">
              {task ? task.title : agent.lastSaid ?? 'sem tarefa no momento'}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
