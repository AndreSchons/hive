import type { RoleDefinition } from '@hive/protocol';
import { AreaBadge, areaStyle, areasOf } from './AreaBadge';

export interface TeamPanelProps {
  readonly roles: readonly RoleDefinition[];
  /** Papeis que ja entraram no escritorio nesta execucao. */
  readonly activeRoles: ReadonlySet<string>;
}

/**
 * A equipe inteira, por area de conhecimento, antes mesmo de qualquer execucao.
 * Diz quem existe e, durante a execucao, quem ja entrou para trabalhar.
 */
export function TeamPanel({ roles, activeRoles }: TeamPanelProps) {
  const areas = areasOf(roles);
  if (areas.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2 px-3 py-3">
      {areas.map((area) => {
        const doArea = roles.filter((role) => role.area === area);
        const ativo = doArea.some((role) => activeRoles.has(String(role.id)));
        return (
          <li
            key={area}
            className="rounded-lg border border-edge px-3 py-2"
            style={{ borderColor: ativo ? `${areaStyle(area).color}88` : undefined }}
          >
            <div className="flex items-center gap-2">
              <AreaBadge area={area} />
              <span className="ml-auto text-[11px] text-muted">
                {ativo ? 'trabalhando nesta execucao' : 'aguardando'}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {doArea.map((role) => role.title).join(' · ')}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
