import { useState, type FormEvent } from 'react';
import type { RoleDefinition } from '@office/protocol';

export interface TaskInputProps {
  readonly disabled: boolean;
  readonly roles: readonly RoleDefinition[];
  readonly onAdd: (goal: string, role: string) => void;
}

/**
 * Uma tarefa e quem vai fazer. Enquanto nao existe gerente que divida sozinho,
 * a atribuicao e da propria pessoa -- entao ela precisa estar aqui, ao lado do
 * que esta sendo pedido, e nao escondida numa tela de configuracao.
 */
export function TaskInput({ disabled, roles, onAdd }: TaskInputProps) {
  const [text, setText] = useState('');
  const [role, setRole] = useState('');
  const trimmed = text.trim();
  const chosen = role !== '' ? role : (roles[0]?.id ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length === 0 || disabled || chosen === '') return;
    onAdd(trimmed, chosen);
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

      <div className="flex gap-2">
        <select
          aria-label="Quem faz"
          value={chosen}
          disabled={disabled}
          onChange={(event) => setRole(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        >
          {roles.map((option) => (
            <option key={option.id} value={option.id}>
              {option.title}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={disabled || trimmed.length === 0}
          className="shrink-0 rounded-lg border border-edge bg-floor px-3 py-2 text-sm transition hover:border-accent disabled:opacity-40"
        >
          Adicionar
        </button>
      </div>
    </form>
  );
}
