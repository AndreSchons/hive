import { useState } from 'react';
import type { AgentCard as Card } from '../state/agent-card';

export interface AgentCardProps {
  readonly card: Card;
  readonly color: string;
  readonly onClose: () => void;
}

/**
 * A ficha do personagem: quem e, com que ferramenta, em que capricho, o que
 * esta fazendo e quanto ja custou.
 *
 * Nao sabe nada de 3D -- recebe uma ficha ja escrita em portugues e desenha.
 * Quem a ancora sobre a cabeca certa e o mundo, que por sua vez nao le uma
 * palavra do que esta aqui dentro.
 *
 * Todo detalhe tecnico (id, branch, caminho da copia, nome canonico de modelo)
 * fica atras do mesmo clique que o feed usa, e nunca solto na tela.
 */
export function AgentCard({ card, color, onClose }: AgentCardProps) {
  const [aberto, setAberto] = useState(false);

  return (
    <div className="w-72 rounded-xl border border-edge bg-panel/95 p-3 text-left shadow-xl shadow-black/40 backdrop-blur">
      <div className="flex items-baseline gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.displayName}</span>
        <span className="shrink-0 text-[11px] text-muted">{card.stateLabel}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="-mr-1 shrink-0 px-1 text-muted hover:text-ink"
        >
          ×
        </button>
      </div>
      <p className="truncate text-xs text-muted">{card.subtitle}</p>

      <dl className="mt-3 flex flex-col gap-2">
        {card.rows.map((row) => (
          <div key={row.label}>
            <dt className="text-[10px] tracking-wide text-muted uppercase">{row.label}</dt>
            <dd className="text-sm leading-snug">{row.value}</dd>
            {row.note !== undefined && (
              <dd className="text-xs leading-snug text-muted">{row.note}</dd>
            )}
          </div>
        ))}
      </dl>

      <div className="mt-3 border-t border-edge pt-2">
        <button
          type="button"
          onClick={() => setAberto(!aberto)}
          className="text-[11px] text-muted underline underline-offset-2 hover:text-ink"
        >
          {aberto ? 'esconder detalhe tecnico' : 'ver detalhe tecnico'}
        </button>
        {aberto && (
          <pre className="mt-1 overflow-x-auto rounded bg-floor p-2 font-mono text-[10px] leading-relaxed text-muted">
            {card.detail}
          </pre>
        )}
      </div>
    </div>
  );
}
