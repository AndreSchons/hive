import type { Plan, RoleDefinition } from '@office/protocol';

export interface PlanReviewProps {
  readonly plan: Plan;
  readonly roles: readonly RoleDefinition[];
}

/**
 * O plano do gerente, como quem nao le codigo precisa ver.
 *
 * Nada de id, comando de portao ou caminho de arquivo: isso e detalhe tecnico e
 * fica fora. O que aparece e a ordem, quem faz cada passo, o que cada um espera
 * do anterior, e o criterio de pronto -- que e o unico jeito de alguem julgar se
 * a divisao faz sentido antes de os agentes comecarem.
 */
export function PlanReview({ plan, roles }: PlanReviewProps) {
  const title = (id: string): string => roles.find((role) => role.id === id)?.title ?? id;
  const position = new Map(plan.subtasks.map((subtask, index) => [subtask.id, index + 1]));

  return (
    <div className="mt-4 flex flex-col gap-3">
      {plan.contracts.length > 0 && (
        <p className="rounded-lg border border-edge bg-floor/60 px-3 py-2 text-xs leading-snug text-muted">
          Antes de dividir, combinei {plan.contracts.length === 1 ? 'um ponto' : 'alguns pontos'} que
          todos precisam seguir: {plan.contracts.map((contract) => contract.title).join(', ')}.
        </p>
      )}

      <ol className="flex flex-col gap-2">
        {plan.subtasks.map((subtask, index) => {
          const espera = subtask.dependsOn
            .map((id) => position.get(id))
            .filter((step): step is number => step !== undefined);

          return (
            <li
              key={subtask.id}
              className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 text-xs text-muted">{index + 1}.</span>
                <span className="min-w-0 flex-1 font-medium">{subtask.title}</span>
                <span className="shrink-0 rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted">
                  {title(subtask.role)}
                </span>
              </div>

              <p className="mt-1 pl-5 text-xs leading-snug text-muted">
                Pronto quando: {subtask.doneWhen}
              </p>
              {espera.length > 0 && (
                <p className="mt-1 pl-5 text-xs leading-snug text-muted">
                  Comeca depois {espera.length === 1 ? 'do passo' : 'dos passos'}{' '}
                  {espera.join(' e ')}.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
