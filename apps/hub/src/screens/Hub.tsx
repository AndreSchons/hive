import { useMemo } from 'react';
import { AgentList } from '../components/AgentList';
import { EventFeed } from '../components/EventFeed';
import { HumanQuestion } from '../components/HumanQuestion';
import { PlanReview } from '../components/PlanReview';
import { TaskInput } from '../components/TaskInput';
import { TaskQueue } from '../components/TaskQueue';
import { adapterLabel } from '../state/describe';
import { useHub } from '../state/world-store';
import { Scene } from '../world';

const STATUS_LABEL = {
  idle: 'parado',
  running: 'em andamento',
  completed: 'concluido',
  failed: 'interrompido',
} as const;

export function Hub() {
  const { project, world, roles, queue, effort, busy, failure, startRun, startPlannedRun,
    addTask, setEffort, removeTask, startSimulation, answerQuestion, closeProject,
    dismissFailure } = useHub();

  const agents = useMemo(() => Object.values(world.agents), [world.agents]);
  const running = world.status === 'running';
  // A da frente. As outras aparecem depois que esta for respondida.
  const pergunta = world.questions[0];

  const queued = useMemo(
    () =>
      queue.map((item) => {
        const definition = roles.find((role) => role.id === item.role);
        return {
          ...item,
          roleTitle: definition?.title ?? item.role,
          adapterTitle: adapterLabel(definition?.adapter ?? ''),
        };
      }),
    [queue, roles],
  );

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
          <TaskInput
            disabled={busy || running}
            roles={roles}
            effort={effort}
            onAdd={addTask}
            onEffort={setEffort}
            onPlan={(goal) => void startPlannedRun(goal)}
          />
          <TaskQueue
            items={queued}
            disabled={busy || running}
            onRemove={removeTask}
            onStart={() => void startRun()}
          />
          <p className="mt-2 text-[11px] leading-snug text-muted">
            Cada tarefa roda numa copia separada do projeto e so entra depois de
            integrada. Se dois trabalhos se cruzarem, eu paro e pergunto.{' '}
            <button
              type="button"
              disabled={busy || running}
              onClick={() => void startSimulation('Execucao simulada')}
              className="underline underline-offset-2 hover:text-ink disabled:opacity-40"
            >
              Ver uma execucao simulada
            </button>{' '}
            para conhecer o fluxo inteiro sem gastar nada.
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

      {/* Uma de cada vez, mesmo com dois especialistas travados: responder duas
          coisas ao mesmo tempo e o oposto do que este produto promete. As
          outras esperam a vez na fila. */}
      {pergunta && (
        <HumanQuestion
          question={pergunta}
          pendentes={world.questions.length - 1}
          onAnswer={(answer, optionId) => void answerQuestion(pergunta.questionId, answer, optionId)}
        >
          {pergunta.cause === 'plan_review' && world.plan !== null && (
            <PlanReview plan={world.plan} roles={roles} />
          )}
        </HumanQuestion>
      )}
    </div>
  );
}
