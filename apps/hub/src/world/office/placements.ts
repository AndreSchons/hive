import type { AgentState } from '@office/protocol';
import type { AgentView } from '../../state/event-reducer';
import { agentColor, HAIR_TONES, hashString, PANTS_TONES, SKIN_TONES } from './palette';
import { allocateDesks, OVERFLOW_DESK } from './deskAllocator';
import {
  aisleRoute,
  DESKS,
  DOOR_WORLD,
  LOUNGE_SEATS,
  OVERFLOW_SPOTS,
  tileToWorld,
  type WorldPoint,
} from './layout';

/**
 * Modo de animacao "de repouso" do personagem. `walk` nao aparece aqui: andar
 * e decisao de quem renderiza -- se a posicao atual difere do alvo, o modo e
 * walk ate chegar.
 *
 * `armchair` e `floor` sao os dois jeitos de descansar depois de entregar. Sao
 * modos separados, e nao um `rest` com um parametro de altura, porque a pose
 * inteira muda: quem esta na poltrona senta alto e recostado, quem esta no
 * tapete senta baixo com os bracos apoiados atras.
 */
export type BaseAnim = 'idle' | 'think' | 'type' | 'armchair' | 'floor';

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
  /**
   * Paradas obrigatorias antes do alvo. Vazio no caso comum -- o L direto
   * resolve. Cheio na travessia do escritorio, que precisa sair da baia pelo
   * corredor em vez de cortar por cima das cadeiras dos colegas.
   */
  readonly via: readonly WorldPoint[];
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
 *
 * `done` nao entra aqui: quem terminou nao tem modo de repouso, tem lugar no
 * lounge -- e quem decide isso e `restingSpot`, que precisa saber a ordem de
 * chegada e nao so o estado.
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
 * Quem ja terminou, na ordem em que terminou.
 *
 * Ordenar por `doneSeq` -- e nao pela ordem dos agentes no mundo -- e o que faz
 * a fila do lounge so crescer pelo fim: quem sentou primeiro nunca muda de
 * lugar quando o proximo chega, do mesmo jeito que a mesa de quem esta
 * trabalhando nunca muda quando alguem novo aparece.
 */
function restingOrder(list: readonly AgentView[]): Readonly<Record<string, number>> {
  const order: Record<string, number> = {};
  const done = list
    .filter((agent) => !agent.present)
    .sort((a, b) => (a.doneSeq ?? 0) - (b.doneSeq ?? 0));

  for (const [index, agent] of done.entries()) order[agent.agentId] = index;
  return order;
}

/**
 * Deriva o posicionamento de cada personagem do estado reduzido. Puro e
 * deterministico: a alocacao de mesas roda sobre TODOS os agentes que ja
 * apareceram na execucao (despawned inclusos, na ordem de spawn), entao a
 * mesa de um agente nunca muda enquanto ele esta vivo e o replay reproduz o
 * mesmo escritorio. Mesa de quem saiu nao e reciclada nesta sessao.
 *
 * Quem termina nao sai do escritorio: ganha um lugar no lounge e fica la
 * enquanto os outros trabalham.
 */
export function derivePlacements(agents: Readonly<Record<string, AgentView>>): readonly Placement[] {
  const list = Object.values(agents);
  const desks = allocateDesks(list.map((agent) => agent.agentId));
  const resting = restingOrder(list);
  let overflowOrder = 0;

  return list.map((agent) => {
    // Terminou: larga a mesa e vai para o lounge. Esta decisao vem antes da
    // mesa porque o lugar de quem descansa nao tem nada a ver com onde ele
    // trabalhou -- e porque a mesa dele continua alocada, so que vazia.
    const deskIndex = desks[agent.agentId] ?? OVERFLOW_DESK;
    const seated = agent.state === 'working';
    const desk = deskIndex === OVERFLOW_DESK ? undefined : DESKS[deskIndex];

    const restIndex = resting[agent.agentId];
    if (restIndex !== undefined) {
      return { ...identity(agent), ...restingAt(restIndex, desk) };
    }

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

    return {
      ...identity(agent),
      target,
      // Ir para a propria mesa e a viagem que o L direto ja resolve: e para ela
      // que o layout foi desenhado.
      via: [],
      rotationY,
      anim: animFor(agent.state),
      seated,
    };
  });
}

type Spot = Pick<Placement, 'target' | 'via' | 'rotationY' | 'anim' | 'seated'>;

/**
 * Onde e como quem terminou descansa, pela ordem em que chegou ao lounge.
 *
 * `desk` e a mesa de onde ele esta saindo, e entra so para a rota: sair de uma
 * baia sem passar pelo vao em frente a ela atravessa a cadeira do colega.
 */
function restingAt(index: number, desk: (typeof DESKS)[number] | undefined): Spot {
  const exit = desk === undefined ? undefined : tileToWorld(desk.stand);
  const seat = LOUNGE_SEATS[index];

  if (seat !== undefined) {
    return {
      target: seat.point,
      via: aisleRoute(exit, DOOR_WORLD, seat.point),
      rotationY: seat.rotationY,
      anim: seat.kind,
      seated: true,
    };
  }

  // Lounge cheio. Encostar na fileira de espera e melhor que empilhar dois
  // bonecos no mesmo ponto -- de longe se le como gente esperando, e nao como
  // um bug de desenho.
  const spot = OVERFLOW_SPOTS[(index - LOUNGE_SEATS.length) % OVERFLOW_SPOTS.length];
  const target = spot === undefined ? DOOR_WORLD : tileToWorld(spot.tile);
  return {
    target,
    via: aisleRoute(exit, DOOR_WORLD, target),
    rotationY: spot?.rotationY ?? Math.PI,
    anim: 'idle',
    seated: false,
  };
}

/**
 * O que o personagem e, independente de onde esta: nome, cor e aparencia. Tudo
 * deterministico por agentId, entao atravessar o escritorio para o lounge nao
 * troca o cabelo de ninguem.
 */
function identity(
  agent: AgentView,
): Pick<Placement, 'agentId' | 'displayName' | 'color' | 'appearance' | 'present' | 'spawnOffset' | 'walkPace'> {
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
    spawnOffset: { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.6 },
    walkPace: 0.85 + (((hash >>> 6) % 40) / 100),
  };
}
