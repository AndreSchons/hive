import { useMemo } from 'react';
import { useHub } from '../../state/world-store';
import { derivePlacements } from '../office/placements';
import { Character } from './Character';

/**
 * A ponte entre o estado reduzido e os bonecos: cada agente vira um Character
 * com cor, mesa e alvo derivados. Aqui nao existe CLI nem modelo -- entra o
 * record de agentes derivado dos eventos, saem bonecos.
 *
 * Ninguem sai de cena: quem termina recebe um alvo no lounge e caminha para la
 * como caminharia para qualquer outro lugar. Por isso este componente nao
 * precisa de temporizador nem de estado proprio -- a saida do escritorio, que
 * era a unica coisa que ele controlava, deixou de existir.
 */
export function AgentCharacters() {
  const agents = useHub((state) => state.world.agents);
  const placements = useMemo(() => derivePlacements(agents), [agents]);

  return (
    <group>
      {placements.map((placement) => (
        <Character key={placement.agentId} placement={placement} />
      ))}
    </group>
  );
}
