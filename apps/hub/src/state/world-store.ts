import { create } from 'zustand';
import type { AnyEvent, ProjectRef } from '@office/protocol';
import { invoke, onEvents } from '../ipc/bridge';
import { applyAll, emptyWorld, type WorldState } from './event-reducer';

interface Failure {
  readonly message: string;
  readonly detail?: string;
}

interface HubState {
  readonly project: ProjectRef | null;
  readonly recents: readonly ProjectRef[];
  readonly world: WorldState;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly subscribed: boolean;

  loadRecents(): Promise<void>;
  pickProject(): Promise<void>;
  openProject(path: string): Promise<void>;
  closeProject(): void;
  startSimulation(goal: string): Promise<void>;
  answerQuestion(answer: string, optionId?: string): Promise<void>;
  dismissFailure(): void;
  ingest(events: readonly AnyEvent[]): void;
  subscribe(): () => void;
}

export const useHub = create<HubState>((set, get) => ({
  project: null,
  recents: [],
  world: emptyWorld,
  busy: false,
  failure: null,
  subscribed: false,

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
      set({ project: response.data, world: emptyWorld });
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
    set({ project: response.data, world: emptyWorld });
    void get().loadRecents();
  },

  closeProject() {
    set({ project: null, world: emptyWorld, failure: null });
  },

  async startSimulation(goal: string) {
    const project = get().project;
    if (project === null) return;

    set({ busy: true, failure: null, world: emptyWorld });
    const response = await invoke('dev.simulate', { projectPath: project.path, goal });
    set({ busy: false });

    if (!response.ok) set({ failure: response.error });
  },

  async answerQuestion(answer: string, optionId?: string) {
    const { world } = get();
    if (world.runId === null || world.question === null) return;

    const response = await invoke('human.answer', {
      runId: world.runId,
      questionId: world.question.questionId,
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
