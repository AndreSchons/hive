import { useMemo, type ReactNode } from 'react';
import { useHub } from '../../state/world-store';
import { derivePlacements } from '../office/placements';
import { Character } from './Character';

export interface AgentCharactersProps {
  /**
   * A janela flutuante do personagem selecionado, montada de fora. Recebe o id
   * e devolve o que desenhar -- este modulo nunca olha dentro.
   */
  readonly cardFor?: (agentId: string) => ReactNode;
}

/**
 * A ponte entre o estado reduzido e os bonecos: cada agente vira um Character
 * com cor, mesa e alvo derivados. Aqui nao existe CLI nem modelo -- entra o
 * record de agentes derivado dos eventos, saem bonecos.
 *
 * Ninguem sai de cena: quem termina recebe um alvo no lounge e caminha para la
 * como caminharia para qualquer outro lugar. Por isso este componente nao
 * precisa de temporizador nem de estado proprio -- a saida do escritorio, que
 * era a unica coisa que ele controlava, deixou de existir.
 *
 * A ficha de um personagem chega por `cardFor`, ja pronta. E o que permite
 * mostrar qual IA e qual modelo estao por tras do boneco sem que esta camada
 * saiba o que e uma CLI.
 */
export function AgentCharacters({ cardFor }: AgentCharactersProps) {
  const agents = useHub((state) => state.world.agents);
  const selected = useHub((state) => state.selected);
  const select = useHub((state) => state.select);
  const placements = useMemo(() => derivePlacements(agents), [agents]);

  return (
    <group>
      {placements.map((placement) => {
        const card = placement.agentId === selected ? cardFor?.(placement.agentId) : undefined;
        return (
          <Character
            key={placement.agentId}
            placement={placement}
            {...(card === undefined || card === null ? {} : { card })}
            onSelect={() => select(placement.agentId)}
          />
        );
      })}
    </group>
  );
}
