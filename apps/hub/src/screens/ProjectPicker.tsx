import { useEffect } from 'react';
import { isInsideApp } from '../ipc/bridge';
import { useHub } from '../state/world-store';

export function ProjectPicker() {
  const { recents, busy, failure, loadRecents, pickProject, openProject, dismissFailure } = useHub();

  useEffect(() => {
    void loadRecents();
  }, [loadRecents]);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-medium">Hive</h1>
        <p className="mt-2 text-sm text-muted">
          Escolha a pasta do projeto em que os agentes vao trabalhar.
        </p>

        {!isInsideApp() && (
          <p className="mt-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
            Esta pagina esta aberta no navegador. Abra pelo aplicativo para escolher uma pasta.
          </p>
        )}

        <button
          type="button"
          onClick={() => void pickProject()}
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-accent px-4 py-3 text-sm font-medium text-floor transition hover:brightness-110 disabled:opacity-40"
        >
          Escolher pasta
        </button>

        {recents.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Recentes</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {recents.map((project) => (
                <li key={project.path}>
                  <button
                    type="button"
                    disabled={busy || !project.exists}
                    onClick={() => void openProject(project.path)}
                    title={project.path}
                    className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-left transition hover:border-accent disabled:opacity-40 disabled:hover:border-edge"
                  >
                    <span className="block truncate text-sm">{project.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {project.exists ? project.path : 'esta pasta nao esta mais no disco'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {failure && (
          <div className="mt-6 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3">
            <p className="text-sm text-bad">{failure.message}</p>
            <button
              type="button"
              onClick={dismissFailure}
              className="mt-2 text-xs text-muted underline underline-offset-2"
            >
              fechar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
