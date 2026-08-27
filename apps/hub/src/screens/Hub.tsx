import { useMemo } from 'react';
import { AgentList } from '../components/AgentList';
import { EventFeed } from '../components/EventFeed';
import { HumanQuestion } from '../components/HumanQuestion';
import { TaskInput } from '../components/TaskInput';
import { useHub } from '../state/world-store';
import { Scene } from '../world';

const STATUS_LABEL = {
  idle: 'parado',
  running: 'em andamento',
  completed: 'concluido',
  failed: 'interrompido',
} as const;

export function Hub() {
  const { project, world, busy, failure, startRun,
    startSimulation, answerQuestion, closeProject, dismissFailure } =
    useHub();

  const agents = useMemo(() => Object.values(world.agents), [world.agents]);
  const running = world.status === 'running';

  if (project === null) return null;

  return (
    <div className="relative flex h-full">
      <aside className="flex w-[22rem] shrink-0 flex-col border-r border-edge bg-panel/40">
        <header className="border-b border-edge px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-sm font-medium">{project.name}</h1>
            <button
              type="button"
              onClick={closeProject}
              className="ml-auto shrink-0 text-xs text-muted underline underline-offset-2 hover:text-ink"
            >
              trocar
            </button>
          </div>
          <p className="truncate text-xs text-muted" title={project.path}>
            {project.path}
          </p>
        </header>

        <div className="border-b border-edge px-4 py-4">
          <TaskInput disabled={busy || running} onSubmit={(goal) => void startRun(goal)} />
          <p className="mt-2 text-[11px] leading-snug text-muted">
            Um agente trabalha direto nesta pasta e para para perguntar quando precisar.{' '}
            <button
              type="button"
              disabled={busy || running}
              onClick={() => void startSimulation('Execucao simulada')}
              className="underline underline-offset-2 hover:text-ink disabled:opacity-40"
            >
              Ver uma execucao simulada
            </button>{' '}
            para conhecer o fluxo com varios agentes, que ainda nao esta ligado.
          </p>
        </div>

        <div className="border-b border-edge">
          <h2 className="px-4 pt-3 text-xs font-medium tracking-wide text-muted uppercase">
            No escritorio
          </h2>
          <AgentList agents={agents} tasks={world.tasks} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <h2 className="sticky top-0 bg-panel/95 px-4 py-2 text-xs font-medium tracking-wide text-muted uppercase backdrop-blur">
            O que esta acontecendo
          </h2>
          <EventFeed items={world.feed} />
        </div>
      </aside>

      <main className="relative min-w-0 flex-1">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-5 py-3">
          <span className="rounded-full border border-edge bg-panel/80 px-3 py-1 text-xs text-muted backdrop-blur">
            {STATUS_LABEL[world.status]}
          </span>
          {world.goal !== null && (
            <span className="truncate rounded-full border border-edge bg-panel/80 px-3 py-1 text-xs backdrop-blur">
              {world.goal}
            </span>
          )}
        </div>

        <Scene />

        {failure && (
          <div className="absolute inset-x-5 bottom-5 z-10 rounded-lg border border-bad/40 bg-panel px-4 py-3">
            <p className="text-sm text-bad">{failure.message}</p>
            <button
              type="button"
              onClick={dismissFailure}
              className="mt-1 text-xs text-muted underline underline-offset-2"
            >
              fechar
            </button>
          </div>
        )}
      </main>

      {world.question && (
        <HumanQuestion
          question={world.question}
          onAnswer={(answer, optionId) => void answerQuestion(answer, optionId)}
        />
      )}
    </div>
  );
}
