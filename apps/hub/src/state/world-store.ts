import { create } from 'zustand';
import type { AnyEvent, ModelTier, ProjectRef, RoleDefinition } from '@hive/protocol';
import { invoke, onEvents } from '../ipc/bridge';
import { applyAll, emptyWorld, type WorldState } from './event-reducer';

interface Failure {
  readonly message: string;
  readonly detail?: string;
}

/** Uma tarefa na fila, ainda so no renderer: o log so conhece o que ja comecou. */
export interface QueuedTask {
  readonly goal: string;
  readonly role: string;
}

interface HubState {
  readonly project: ProjectRef | null;
  readonly recents: readonly ProjectRef[];
  readonly roles: readonly RoleDefinition[];
  readonly queue: readonly QueuedTask[];
  /** Quanto capricho a fila manual pede. So vale para ela. */
  readonly effort: ModelTier;
  readonly world: WorldState;
  /**
   * Personagem com a ficha aberta, ou `null`. Mora aqui e nao no mundo 3D
   * porque quem abre a ficha e o clique e quem a fecha pode ser outra tela --
   * e porque `WorldState` e derivado so do log, e selecao nao e evento.
   */
  readonly selected: string | null;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly subscribed: boolean;

  loadRecents(): Promise<void>;
  loadRoles(): Promise<void>;
  addTask(goal: string, role: string): void;
  setEffort(effort: ModelTier): void;
  removeTask(index: number): void;
  pickProject(): Promise<void>;
  openProject(path: string): Promise<void>;
  closeProject(): void;
  startRun(): Promise<void>;
  startPlannedRun(goal: string): Promise<void>;
  startSimulation(goal: string): Promise<void>;
  answerQuestion(questionId: string, answer: string, optionId?: string): Promise<void>;
  select(agentId: string | null): void;
  dismissFailure(): void;
  ingest(events: readonly AnyEvent[]): void;
  subscribe(): () => void;
}

export const useHub = create<HubState>((set, get) => ({
  project: null,
  recents: [],
  roles: [],
  queue: [],
  effort: 'economico',
  world: emptyWorld,
  selected: null,
  busy: false,
  failure: null,
  subscribed: false,

  async loadRoles() {
    const response = await invoke('roster.get', {});
    if (response.ok) set({ roles: response.data });
    else set({ failure: response.error });
  },

  select(agentId: string | null) {
    set({ selected: agentId });
  },

  setEffort(effort: ModelTier) {
    set({ effort });
  },

  addTask(goal: string, role: string) {
    set({ queue: [...get().queue, { goal, role }] });
  },

  removeTask(index: number) {
    set({ queue: get().queue.filter((_, position) => position !== index) });
  },

  async loadRecents() {
    const response = await invoke('project.recent', {});
    if (response.ok) set({ recents: response.data });
    else set({ failure: response.error });
  },

  async pickProject() {
    set({ busy: true, failure: null });
    const response = await invoke('project.pick', {});
    set({ busy: false });

    if (!response.ok) {
      set({ failure: response.error });
      return;
    }
    // Cancelar o dialogo devolve null, e isso nao e erro.
    if (response.data !== null) {
      set({ project: response.data, world: emptyWorld, selected: null });
      void get().loadRecents();
    }
  },

  async openProject(path: string) {
    set({ busy: true, failure: null });
    const response = await invoke('project.open', { path });
    set({ busy: false });

    if (!response.ok) {
      set({ failure: response.error });
      void get().loadRecents();
      return;
    }
    set({ project: response.data, world: emptyWorld, selected: null });
    void get().loadRecents();
  },

  closeProject() {
    set({ project: null, world: emptyWorld, queue: [], failure: null, selected: null });
  },

  async startRun() {
    const { project, queue } = get();
    if (project === null || queue.length === 0) return;

    set({ busy: true, failure: null, world: emptyWorld, selected: null });
    const response = await invoke('run.start', {
      projectPath: project.path,
      request: { mode: 'queue', tasks: [...queue], modelTier: get().effort },
    });
    set({ busy: false });

    // CLI ausente, pasta que nao e repositorio ou arvore suja voltam como frase,
    // nunca como excecao: e o unico lugar onde a pessoa descobre o que falta.
    if (!response.ok) {
      set({ failure: response.error });
      return;
    }
    // A fila so sai da tela quando a execucao existe de verdade.
    set({ queue: [] });
  },

  /**
   * O caminho do gerente: a pessoa so diz o que quer. A fila fica intacta --
   * quem planeja e o gerente, e ela nao esta abrindo mao do que ja montou.
   */
  async startPlannedRun(goal: string) {
    const project = get().project;
    if (project === null || goal.trim().length === 0) return;

    set({ busy: true, failure: null, world: emptyWorld, selected: null });
    const response = await invoke('run.start', {
      projectPath: project.path,
      request: { mode: 'planned', goal: goal.trim() },
    });
    set({ busy: false });

    if (!response.ok) set({ failure: response.error });
  },

  async startSimulation(goal: string) {
    const project = get().project;
    if (project === null) return;

    set({ busy: true, failure: null, world: emptyWorld, selected: null });
    const response = await invoke('dev.simulate', { projectPath: project.path, goal });
    set({ busy: false });

    if (!response.ok) set({ failure: response.error });
  },

  async answerQuestion(questionId: string, answer: string, optionId?: string) {
    const { world } = get();
    // O id vem de quem esta na tela, e nao de "a pergunta aberta": com duas na
    // fila, responder pela posicao entregaria a resposta a outra pergunta.
    if (world.runId === null) return;

    const response = await invoke('human.answer', {
      runId: world.runId,
      questionId,
      answer,
      ...(optionId === undefined ? {} : { optionId }),
    });

    if (!response.ok) {
      set({ failure: response.error });
      return;
    }
    if (!response.data.accepted) {
      set({ failure: { message: 'A execucao nao esta mais ativa, entao a resposta nao foi entregue.' } });
    }
    // O estado nao muda aqui: a resposta so vale quando voltar como evento no
    // log. Uma unica fonte de verdade, ida e volta.
  },

  dismissFailure() {
    set({ failure: null });
  },

  ingest(events: readonly AnyEvent[]) {
    if (events.length === 0) return;
    set({ world: applyAll(get().world, events) });
  },

  subscribe() {
    if (get().subscribed) return () => {};
    set({ subscribed: true });

    const unsubscribe = onEvents((batch) => {
      get().ingest(batch.events);
    });

    return () => {
      unsubscribe();
      set({ subscribed: false });
    };
  },
}));
