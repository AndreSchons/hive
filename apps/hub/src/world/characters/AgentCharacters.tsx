import { useEffect, useMemo, useRef, useState } from 'react';
import { useHub } from '../../state/world-store';
import { derivePlacements } from '../office/placements';
import { Character, DESPAWN_LINGER_MS } from './Character';

/**
 * A ponte entre o estado reduzido e os bonecos: cada agente vira um Character
 * com cor, mesa e alvo derivados; quem recebeu `agent.despawned` toca a saida
 * e so sai de cena quando a fumaca cobriu o rastro. Aqui nao existe CLI nem
 * modelo -- entra o record de agentes derivado dos eventos, saem bonecos.
 */
export function AgentCharacters() {
  const agents = useHub((state) => state.world.agents);
  const [departed, setDeparted] = useState<readonly string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const placements = useMemo(() => derivePlacements(agents), [agents]);

  useEffect(() => {
    const scheduled = timers.current;

    // Execucao nova ou projeto trocado: ninguem da rodada anterior fica para tras.
    if (Object.keys(agents).length === 0) {
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
      setDeparted((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    for (const agent of Object.values(agents)) {
      if (!agent.present && !scheduled.has(agent.agentId)) {
        scheduled.set(
          agent.agentId,
          setTimeout(() => {
            setDeparted((prev) => (prev.includes(agent.agentId) ? prev : [...prev, agent.agentId]));
          }, DESPAWN_LINGER_MS),
        );
      }
    }
  }, [agents]);

  // Ao desmontar (troca de tela), cancela as saidas pendentes.
  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    };
  }, []);

  return (
    <group>
      {placements
        .filter((placement) => placement.present || !departed.includes(placement.agentId))
        .map((placement) => (
          <Character
            key={placement.agentId}
            placement={placement}
            departing={!placement.present}
          />
        ))}
    </group>
  );
}
