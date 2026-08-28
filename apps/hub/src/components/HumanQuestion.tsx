import { useState, type ReactNode } from 'react';
import type { BlockCause } from '@office/protocol';
import type { PendingQuestion } from '../state/event-reducer';

/**
 * A mesma parada tem leituras diferentes: pedir autorizacao para mexer em algo
 * nao e a mesma coisa que perguntar uma preferencia. O rotulo prepara a pessoa
 * para o tipo de decisao que ela vai tomar.
 */
const CAUSE_LABEL: Record<BlockCause, string> = {
  agent_asked: 'Preciso da sua ajuda',
  permission: 'Preciso da sua autorizacao',
  gate_failed: 'A verificacao nao passou',
  budget: 'Cheguei no limite',
  merge_conflict: 'Dois trabalhos se cruzaram',
  agent_crashed: 'Algo deu errado',
  plan_review: 'Dividi o trabalho assim',
};

export interface HumanQuestionProps {
  readonly question: PendingQuestion;
  readonly onAnswer: (answer: string, optionId?: string) => void;
  /** O plano em revisao. So aparece quando a pergunta e o aval do gerente. */
  readonly children?: ReactNode;
}

/**
 * O momento em que o sistema para e pede ajuda. E a experiencia principal do
 * produto, entao ocupa a tela inteira em vez de virar um aviso no canto: nada
 * mais acontece ate a pessoa responder.
 */
export function HumanQuestion({ question, onAnswer, children }: HumanQuestionProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-floor/85 p-6 backdrop-blur-sm">
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-ask/40 bg-panel p-6 shadow-2xl">
        <p className="text-xs font-medium tracking-wide text-ask uppercase">
          {CAUSE_LABEL[question.cause]}
        </p>

        <h2 className="mt-3 text-xl leading-snug font-medium text-balance">{question.question}</h2>
        <p className="mt-2 text-sm text-muted">{question.context}</p>

        {children}

        <div className="mt-5 flex flex-col gap-2">
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onAnswer(option.label, option.id)}
              className="rounded-lg border border-edge bg-floor px-4 py-3 text-left text-sm transition hover:border-ask hover:bg-edge/60"
            >
              {option.label}
            </button>
          ))}
        </div>

        {question.allowFreeText && (
          <div className="mt-4 border-t border-edge pt-4">
            <label htmlFor="answer" className="text-xs text-muted">
              Ou responda com suas palavras
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="answer"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && trimmed.length > 0) onAnswer(trimmed);
                }}
                placeholder="Escreva aqui"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-floor px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-ask"
              />
              <button
                type="button"
                disabled={trimmed.length === 0}
                onClick={() => onAnswer(trimmed)}
                className="rounded-lg bg-ask px-4 py-2 text-sm font-medium text-floor disabled:opacity-40"
              >
                Enviar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
