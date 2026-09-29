import type { RoleDefinition } from '@hive/protocol';

/**
 * Cor e simbolo de cada area de conhecimento. Uma area fora da lista ainda
 * aparece, em cinza: o roster e configuracao, e esconder uma area nova seria
 * pior que mostra-la sem cor.
 */
const AREA_STYLE: Readonly<Record<string, { readonly icon: string; readonly color: string }>> = {
  'Engenharia de Software': { icon: '💻', color: '#6ea8fe' },
  Direito: { icon: '⚖️', color: '#b79cf5' },
  Administração: { icon: '📊', color: '#e8c37a' },
  'Ciências Contábeis': { icon: '🧮', color: '#58d6a0' },
};

const NEUTRAL = { icon: '👤', color: '#8697b0' };

export const areaStyle = (area: string): { readonly icon: string; readonly color: string } =>
  AREA_STYLE[area] ?? NEUTRAL;

/** Todas as areas do roster, na ordem em que aparecem nele, sem repetir. */
export function areasOf(roles: readonly RoleDefinition[]): string[] {
  return [...new Set(roles.flatMap((role) => (role.area === undefined ? [] : [role.area])))];
}

export function AreaBadge({ area, size = 'sm' }: { readonly area: string; readonly size?: 'sm' | 'md' }) {
  const { icon, color } = areaStyle(area);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border font-medium whitespace-nowrap ${
        size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-px text-[10px]'
      }`}
      style={{ color, borderColor: `${color}66`, backgroundColor: `${color}1a` }}
    >
      <span aria-hidden>{icon}</span>
      {area}
    </span>
  );
}
