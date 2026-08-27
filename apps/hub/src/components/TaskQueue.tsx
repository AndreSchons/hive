export interface QueuedTask {
  readonly goal: string;
  readonly role: string;
  readonly roleTitle: string;
  readonly adapterTitle: string;
}

export interface TaskQueueProps {
  readonly items: readonly QueuedTask[];
  readonly disabled: boolean;
  readonly onRemove: (index: number) => void;
  readonly onStart: () => void;
}

/**
 * A fila montada, na ordem em que vai acontecer. Cada tarefa roda sozinha, na
 * copia do seu dono, e so entra no projeto depois de integrada -- por isso a
 * ordem e visivel: ela e o que decide quem encontra o trabalho de quem.
 */
export function TaskQueue({ items, disabled, onRemove, onStart }: TaskQueueProps) {
  if (items.length === 0) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      <ol className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li
            key={`${item.goal}-${index}`}
            className="flex items-start gap-2 rounded-lg border border-edge bg-floor px-3 py-2 text-xs"
          >
            <span className="mt-0.5 shrink-0 text-muted tabular-nums">{index + 1}.</span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2">{item.goal}</span>
              <span className="text-muted">
                {item.roleTitle} · {item.adapterTitle}
              </span>
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(index)}
              aria-label={`Tirar da fila: ${item.goal}`}
              className="shrink-0 text-muted transition hover:text-bad disabled:opacity-40"
            >
              tirar
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        disabled={disabled}
        onClick={onStart}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-floor transition hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
      >
        Comecar {items.length === 1 ? 'a tarefa' : `as ${items.length} tarefas`}
      </button>
    </div>
  );
}
