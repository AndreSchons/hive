import { useState, type FormEvent } from 'react';

export interface TaskInputProps {
  readonly disabled: boolean;
  readonly onSubmit: (goal: string) => void;
}

export function TaskInput({ disabled, onSubmit }: TaskInputProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length === 0 || disabled) return;
    onSubmit(trimmed);
    setText('');
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="task" className="text-xs font-medium tracking-wide text-muted uppercase">
        O que voce quer que seja feito
      </label>
      <textarea
        id="task"
        rows={3}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
        }}
        placeholder="Ex.: adicionar login com email e senha"
        className="resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || trimmed.length === 0}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-floor transition hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
      >
        Comecar
      </button>
    </form>
  );
}
