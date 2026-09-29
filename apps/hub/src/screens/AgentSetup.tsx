import { useEffect } from 'react';
import type { AdapterStatus } from '@hive/protocol';
import { useHub } from '../state/world-store';

const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
const GIT_INSTALL_URL = 'https://git-scm.com/downloads';

/**
 * Primeira abertura. O Hive nao traz inteligencia artificial propria: ele usa a
 * que ja esta instalada no computador. Esta tela diz o que achou e so segue
 * depois que a pessoa autoriza -- achar a CLI nao e permissao para usa-la.
 */
export function AgentSetup() {
  const { setup, busy, failure, loadSetup, allowAdapter, dismissFailure } = useHub();

  useEffect(() => {
    void loadSetup();
  }, [loadSetup]);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-medium">Bem-vindo ao Hive</h1>
        <p className="mt-2 text-sm text-muted">
          O Hive coordena a inteligencia artificial que ja esta instalada neste computador. Primeiro,
          vamos ver o que tem por aqui.
        </p>

        {setup === null ? (
          <p className="mt-6 text-sm text-muted">Procurando...</p>
        ) : (
          <ul className="mt-6 flex flex-col gap-3">
            {setup.adapters.map((status) => (
              <AdapterRow
                key={status.adapter}
                status={status}
                busy={busy}
                onAllow={() => void allowAdapter(status.adapter)}
              />
            ))}
            {!setup.gitFound && (
              <li className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
                <p className="text-warn">
                  Falta o Git, que o Hive usa para cada agente trabalhar numa copia separada do seu
                  projeto.
                </p>
                <a href={GIT_INSTALL_URL} target="_blank" rel="noreferrer" className="mt-2 inline-block text-accent underline underline-offset-2">
                  Como instalar o Git
                </a>
              </li>
            )}
          </ul>
        )}

        {setup !== null && (setup.adapters.some((a) => !a.found) || !setup.gitFound) && (
          <button
            type="button"
            onClick={() => void loadSetup()}
            disabled={busy}
            className="mt-6 w-full rounded-lg border border-edge px-4 py-3 text-sm transition hover:border-accent disabled:opacity-40"
          >
            Ja instalei, procurar de novo
          </button>
        )}

        {failure && (
          <div className="mt-6 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3">
            <p className="text-sm text-bad">{failure.message}</p>
            <button type="button" onClick={dismissFailure} className="mt-2 text-xs text-muted underline underline-offset-2">
              fechar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AdapterRow({ status, busy, onAllow }: { status: AdapterStatus; busy: boolean; onAllow: () => void }) {
  if (!status.found) {
    return (
      <li className="rounded-lg border border-edge bg-panel px-4 py-3 text-sm">
        <p>Nao encontrei o {status.displayName} neste computador.</p>
        <p className="mt-1 text-muted">Instale e entre com a sua conta; depois volte aqui.</p>
        <a href={CLAUDE_INSTALL_URL} target="_blank" rel="noreferrer" className="mt-2 inline-block text-accent underline underline-offset-2">
          Como instalar o {status.displayName}
        </a>
        {status.reason !== undefined && <Detail text={status.reason} />}
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-edge bg-panel px-4 py-3 text-sm">
      <p>Encontrei o {status.displayName} neste computador.</p>
      {status.allowed ? (
        <p className="mt-1 text-muted">Autorizado.</p>
      ) : (
        <>
          <p className="mt-1 text-muted">
            O Hive vai usa-lo para trabalhar nos projetos que voce escolher, e sempre mostra o plano
            para voce aprovar antes de mexer em qualquer coisa.
          </p>
          <button
            type="button"
            onClick={onAllow}
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-floor transition hover:brightness-110 disabled:opacity-40"
          >
            Permitir que o Hive use o {status.displayName}
          </button>
        </>
      )}
      <Detail text={`versao ${status.version ?? '?'} -- ${status.executable ?? ''}`} />
    </li>
  );
}

function Detail({ text }: { text: string }) {
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer">detalhes</summary>
      <p className="mt-1 break-all font-mono">{text}</p>
    </details>
  );
}
