import { useState, type FormEvent } from 'react';
import type { ModelTier, RoleDefinition } from '@office/protocol';
import { adapterLabel } from '../state/describe';

export interface TaskInputProps {
  readonly disabled: boolean;
  readonly roles: readonly RoleDefinition[];
  readonly effort: ModelTier;
  readonly onAdd: (goal: string, role: string) => void;
  readonly onEffort: (effort: ModelTier) => void;
  readonly onPlan: (goal: string) => void;
}

/**
 * O que cada degrau significa para quem esta escolhendo, e nao para quem
 * conhece modelo. Medido na mesma tarefa: o economico entregou por US$ 0,048 e
 * o padrao da ferramenta, que e o mais caro, cobrou US$ 0,248 pelo mesmo
 * resultado -- e os dois passaram na verificacao.
 */
const EFFORT_LABEL: Record<ModelTier, string> = {
  economico: 'rapido e barato',
  padrao: 'equilibrado',
  caprichado: 'capricha, custa mais',
};

/**
 * O mesmo campo de texto, dois jeitos de comecar.
 *
 * No modo gerente a pessoa so descreve o que quer, e quem divide e quem escolhe
 * os papeis e o gerente -- que e a promessa do produto para quem nao le codigo.
 * No modo manual ela monta a fila e escolhe o dono de cada item, que continua
 * sendo o caminho previsivel para quem sabe o que quer.
 *
 * A opcao de papel mostra o papel **e** a CLI por tras dele. Escolher
 * "Interface e 3D" sem saber qual CLI roda por tras seria escolher no escuro.
 *
 * No modo manual a pessoa escolhe tambem **quanto capricho**. Sem essa escolha
 * a fila caia no modelo padrao da CLI, que e o mais caro que existe: o caminho
 * que existe para ser o barato era, medido, o mais caro do sistema inteiro.
 */
export function TaskInput({ disabled, roles, effort, onAdd, onEffort, onPlan }: TaskInputProps) {
  const [text, setText] = useState('');
  const [role, setRole] = useState('');
  const [manual, setManual] = useState(false);
  const trimmed = text.trim();
  const chosen = role !== '' ? role : (roles[0]?.id ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length === 0 || disabled) return;

    if (manual) {
      if (chosen === '') return;
      onAdd(trimmed, chosen);
    } else {
      onPlan(trimmed);
    }
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
        {manual && (
          <select
            aria-label="Quem faz"
            value={chosen}
            disabled={disabled}
            onChange={(event) => setRole(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          >
            {roles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title} · {adapterLabel(option.adapter)}
              </option>
            ))}
          </select>
        )}
        {manual && (
          <select
            aria-label="Quanto capricho"
            value={effort}
            disabled={disabled}
            onChange={(event) => onEffort(event.target.value as ModelTier)}
            className="min-w-0 shrink-0 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          >
            {(Object.keys(EFFORT_LABEL) as ModelTier[]).map((tier) => (
              <option key={tier} value={tier}>
                {EFFORT_LABEL[tier]}
              </option>
            ))}
          </select>
        )}
        <button
          type="submit"
          disabled={disabled || trimmed.length === 0}
          className={`shrink-0 rounded-lg px-3 py-2 text-sm transition disabled:opacity-40 ${
            manual
              ? 'border border-edge bg-floor hover:border-accent'
              : 'flex-1 border border-accent bg-accent/15 hover:bg-accent/25'
          }`}
        >
          {manual ? 'Adicionar' : 'Deixar o gerente dividir'}
        </button>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => setManual(!manual)}
        className="self-start text-[11px] text-muted underline underline-offset-2 hover:text-ink disabled:opacity-40"
      >
        {manual ? 'deixar o gerente decidir quem faz' : 'prefiro escolher quem faz cada coisa'}
      </button>
    </form>
  );
}
