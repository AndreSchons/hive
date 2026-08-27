import type { AgentState } from '@office/protocol';
import type { AgentView } from '../../state/event-reducer';
import { agentColor, HAIR_TONES, hashString, PANTS_TONES, SKIN_TONES } from './palette';
import { allocateDesks, OVERFLOW_DESK } from './deskAllocator';
import {
  DESKS,
  DOOR_WORLD,
  OVERFLOW_SPOTS,
  tileToWorld,
  type WorldPoint,
} from './layout';

/**
 * Modo de animacao "de repouso" do personagem. `walk` nao aparece aqui: andar
 * e decisao de quem renderiza -- se a posicao atual difere do alvo, o modo e
 * walk ate chegar.
 */
export type BaseAnim = 'idle' | 'think' | 'type';

/** A aparencia da pessoa: pele, cabelo e calca. A camisa fica com a cor do agente. */
export interface Appearance {
  readonly skin: string;
  readonly hair: string;
  /** 0 chapeu, 1 curto, 2 franja lateral, 3 coque. */
  readonly hairStyle: number;
  readonly pants: string;
}

export interface Placement {
  readonly agentId: string;
  readonly displayName: string;
  readonly color: string;
  readonly appearance: Appearance;
  /** false quando `agent.despawned` ja chegou: toca a saida e some. */
  readonly present: boolean;
  /** Posicao alvo no mundo: a cadeira (trabalhando) ou o pe da mesa. */
  readonly target: WorldPoint;
  /** Rotacao Y quando parado no alvo. */
  readonly rotationY: number;
  readonly anim: BaseAnim;
  readonly seated: boolean;
  /** Deslocamento deterministico no spawn, para spawns juntos nao se sobreporem. */
  readonly spawnOffset: WorldPoint;
  /** Variacao deterministica de velocidade, para nao andarem em passo de desfile. */
  readonly walkPace: number;
}

/**
 * Estado do agente -> modo de animacao. `talking` e `blocked` estao mapeados
 * mas ainda sem animacao propria (proxima sessao): ficam em pe no idle, que e
 * neutro o bastante para nao mentir sobre o que esta acontecendo.
 */
function animFor(state: AgentState): BaseAnim {
  switch (state) {
    case 'working':
      return 'type';
    case 'thinking':
      return 'think';
    case 'idle':
    case 'done':
    case 'talking':
    case 'blocked':
      return 'idle';
  }
}

/**
 * Deriva o posicionamento de cada personagem do estado reduzido. Puro e
 * deterministico: a alocacao de mesas roda sobre TODOS os agentes que ja
 * apareceram na execucao (despawned inclusos, na ordem de spawn), entao a
 * mesa de um agente nunca muda enquanto ele esta vivo e o replay reproduz o
 * mesmo escritorio. Mesa de quem saiu nao e reciclada nesta sessao.
 */
export function derivePlacements(agents: Readonly<Record<string, AgentView>>): readonly Placement[] {
  const list = Object.values(agents);
  const desks = allocateDesks(list.map((agent) => agent.agentId));
  let overflowOrder = 0;

  return list.map((agent) => {
    const deskIndex = desks[agent.agentId] ?? OVERFLOW_DESK;
    const seated = agent.state === 'working';
    const desk = deskIndex === OVERFLOW_DESK ? undefined : DESKS[deskIndex];

    let target: WorldPoint;
    let rotationY: number;
    if (desk !== undefined) {
      target = tileToWorld(seated ? desk.chair : desk.stand);
      // Sentado olha para a mesa; em pe, de costas para ela, olhando a sala
      // (e o rosto, para a camera).
      rotationY = seated ? desk.rotationY : desk.rotationY + Math.PI;
    } else {
      // Sem mesa: fileira de espera junto a parede sul, olhando para a sala.
      const spot = OVERFLOW_SPOTS[overflowOrder % OVERFLOW_SPOTS.length];
      overflowOrder += 1;
      target = spot === undefined ? DOOR_WORLD : tileToWorld(spot.tile);
      rotationY = spot === undefined ? Math.PI : spot.rotationY;
    }

    const hash = hashString(agent.agentId);
    const angle = (hash % 628) / 100;
    const radius = 0.2 + (((hash >>> 8) % 100) / 100) * 0.35;
    // Hash separado para a aparencia, para nao casar com a cor nem com a mesa.
    const look = hashString(`${agent.agentId}:aparencia`);

    return {
      agentId: agent.agentId,
      displayName: agent.displayName,
      color: agentColor(agent.agentId),
      appearance: {
        skin: SKIN_TONES[look % SKIN_TONES.length] ?? SKIN_TONES[0],
        hair: HAIR_TONES[(look >>> 3) % HAIR_TONES.length] ?? HAIR_TONES[0],
        hairStyle: (look >>> 6) % 4,
        pants: PANTS_TONES[(look >>> 9) % PANTS_TONES.length] ?? PANTS_TONES[0],
      },
      present: agent.present,
      target,
      rotationY,
      anim: animFor(agent.state),
      seated,
      spawnOffset: { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.6 },
      walkPace: 0.85 + (((hash >>> 6) % 40) / 100),
    };
  });
}
