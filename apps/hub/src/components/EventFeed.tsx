import { useEffect, useRef, useState } from 'react';
import type { FeedItem, Tone } from '../state/describe';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'text-muted',
  good: 'text-good',
  warn: 'text-warn',
  bad: 'text-bad',
  ask: 'text-ask',
};

const time = (ts: number): string =>
  new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export interface EventFeedProps {
  readonly items: readonly FeedItem[];
}

export function EventFeed({ items }: EventFeedProps) {
  const bottom = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length]);

  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted">
        Nada aconteceu ainda. Descreva o que voce quer e o escritorio comeca a trabalhar.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-1 px-3 py-3 text-sm">
      {items.map((item) => (
        <li key={item.seq} className="rounded-md px-2 py-1 hover:bg-edge/40">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted/70">{time(item.ts)}</span>
            <span className={`${TONE_CLASS[item.tone]} leading-snug`}>{item.text}</span>
          </div>

          {item.detail !== undefined && (
            <div className="pl-14">
              <button
                type="button"
                onClick={() => setOpen(open === item.seq ? null : item.seq)}
                className="text-[11px] text-muted underline underline-offset-2 hover:text-ink"
              >
                {open === item.seq ? 'esconder detalhe tecnico' : 'ver detalhe tecnico'}
              </button>
              {open === item.seq && (
                <pre className="mt-1 overflow-x-auto rounded bg-floor p-2 font-mono text-[11px] text-muted">
                  {item.detail}
                </pre>
              )}
            </div>
          )}
        </li>
      ))}
      <div ref={bottom} />
    </ol>
  );
}
