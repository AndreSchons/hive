import type { AgentState } from '@hive/protocol';
import { STATE_LABEL, adapterLabel } from '../state/describe';
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
  /** Quem esta com a ficha aberta. A lista e o escritorio abrem a mesma. */
  readonly selected?: string | null;
  readonly onSelect?: (agentId: string) => void;
}

export function AgentList({ agents, tasks, selected, onSelect }: AgentListProps) {
  if (agents.length === 0) {
    return <p className="px-4 py-4 text-sm text-muted">O escritorio esta vazio.</p>;
  }

  return (
    <ul className="flex flex-col gap-2 px-3 py-3">
      {agents.map((agent) => {
        const task = agent.currentTaskId === null ? null : tasks[agent.currentTaskId];
        return (
          <li key={agent.agentId}>
            <button
              type="button"
              onClick={() => onSelect?.(agent.agentId)}
              aria-pressed={selected === agent.agentId}
              className={`w-full rounded-lg border px-3 py-2 text-left ${
                selected === agent.agentId ? 'border-accent bg-panel' : 'border-edge bg-panel hover:border-muted/50'
              } ${agent.present ? '' : 'opacity-45'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[agent.state]}`} />
                <span className="truncate text-sm font-medium">{agent.displayName}</span>
                {agent.adapter !== '' && (
                  <span className="shrink-0 rounded border border-edge px-1.5 py-px text-[10px] text-muted">
                    {adapterLabel(agent.adapter)}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-muted">{STATE_LABEL[agent.state]}</span>
              </div>

              <p className="mt-1 truncate text-xs text-muted">
                {task ? task.title : agent.lastSaid ?? 'sem tarefa no momento'}
              </p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
