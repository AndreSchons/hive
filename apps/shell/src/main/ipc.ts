import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  commands,
  isCommandName,
  newRunId,
  rosterSchema,
  type CommandFailure,
  type CommandName,
  type CommandResponse,
  type CommandResult,
  type Roster,
  type RunId,
} from '@office/protocol';
import { AppStore, EventStore } from '@office/store';
import { runScriptedDemo } from '@office/simulator';
import type { EventBridge } from './event-bridge';
import type { RunSupervisor } from './run-supervisor';
import { openProject, pickProject } from './project-dialog';

/**
 * Roster inicial. E configuracao, nao constante do sistema: mora aqui so ate
 * existir a tela onde o usuario edita papeis e associa cada um a uma CLI.
 */
export const DEFAULT_ROSTER: Roster = rosterSchema.parse([
  { id: 'gerente', title: 'Gerente', adapter: 'claude', model: 'opus', canDelegate: true,
    description: 'Decompoe a task, publica contratos, valida entregas e integra.' },
  { id: 'executor', title: 'Agente', adapter: 'claude', canDelegate: false,
    description: 'Executa uma tarefa sozinho, direto na pasta do projeto.' },
  { id: 'frontend', title: 'Interface e 3D', adapter: 'kimi', canDelegate: false,
    description: 'Telas, componentes e o escritorio 3D.' },
  { id: 'backend', title: 'Backend', adapter: 'claude', canDelegate: false,
    description: 'Dados, rotas e regras de negocio.' },
  { id: 'revisao', title: 'Revisao', adapter: 'claude', canDelegate: false,
    description: 'Le o que os outros entregaram antes de integrar.' },
]);

export interface IpcContext {
  readonly events: EventStore;
  readonly app: AppStore;
  readonly bridge: EventBridge;
  readonly runs: RunSupervisor;
  readonly window: () => BrowserWindow | null;
}

/**
 * Cada handler recebe o payload cru e faz o proprio parse com a chave literal
 * do comando -- e por isso que dentro do corpo tudo tem tipo concreto. O tipo
 * mapeado exige um handler por comando e amarra o retorno ao schema de saida,
 * entao esquecer um comando ou devolver a forma errada nao compila.
 */
type Handlers = { [N in CommandName]: (raw: unknown) => CommandResult<N> | Promise<CommandResult<N>> };

function buildHandlers(context: IpcContext): Handlers {
  const { events, app, bridge, runs } = context;

  return {
    'project.pick': async () => {
      const project = await pickProject(context.window(), app);
      // Seguir o projeto, e nao uma execucao: assim uma execucao disparada de
      // fora (o simulador pelo terminal) tambem aparece na janela.
      if (project !== null) bridge.followProject(project.path);
      return project;
    },

    'project.open': (raw) => {
      const { path } = commands['project.open'].input.parse(raw);
      const project = openProject(app, path);
      bridge.followProject(project.path);
      return project;
    },

    'project.recent': (raw) => {
      const { limit } = commands['project.recent'].input.parse(raw);
      return app.recentProjects(limit);
    },

    'project.forget': (raw) => {
      const { path } = commands['project.forget'].input.parse(raw);
      return { removed: app.forgetProject(path) };
    },

    'roster.get': () => DEFAULT_ROSTER,

    'run.start': async (raw) => {
      const { projectPath, tasks } = commands['run.start'].input.parse(raw);
      const runId = await runs.start({ projectPath, tasks });
      // Segue a execucao assim que ela existe: o primeiro evento ja chega na
      // janela sem precisar de um segundo comando.
      bridge.follow(runId, 0);
      return { runId };
    },

    'run.cancel': (raw) => {
      const { runId } = commands['run.cancel'].input.parse(raw);
      return { cancelled: runs.cancel(runId) };
    },

    'run.list': (raw) => {
      const { projectPath, limit } = commands['run.list'].input.parse(raw);
      return events.listRuns(projectPath, limit);
    },

    'run.events': (raw) => {
      const { runId, afterSeq } = commands['run.events'].input.parse(raw);
      // Ler o historico e passar a seguir a execucao sao a mesma intencao: o
      // hub quer estar em dia com esta execucao daqui pra frente.
      bridge.follow(runId, afterSeq);
      return events.read(runId, afterSeq);
    },

    'human.answer': (raw) => {
      const { runId, questionId, answer, optionId } = commands['human.answer'].input.parse(raw);
      if (!events.hasRun(runId)) return { accepted: false };

      // Execucao viva: a resposta destrava o agente, e quem grava o
      // `human.answered` e o adaptador -- o log continua sendo a unica fonte
      // da verdade. Sem execucao viva sobra o caminho do simulador, que le a
      // resposta do proprio log.
      if (runs.answer(runId, questionId, answer, optionId)) return { accepted: true };

      events.append(runId, {
        type: 'human.answered',
        payload: { questionId, answer, ...(optionId === undefined ? {} : { optionId }) },
      });
      return { accepted: true };
    },

    'dev.simulate': (raw) => {
      const { projectPath, goal } = commands['dev.simulate'].input.parse(raw);
      const runId: RunId = newRunId();

      // Segue a execucao antes dela existir: o primeiro evento ja chega na
      // janela sem precisar de um segundo comando.
      bridge.follow(runId, 0);
      void runScriptedDemo({ store: events, runId, projectPath, goal }).catch((error: unknown) => {
        console.error('[simulator] a execucao simulada falhou:', error);
      });
      return { runId };
    },
  };
}

export function registerIpc(context: IpcContext): void {
  const handlers = buildHandlers(context);

  ipcMain.handle(
    IPC_CHANNELS.command,
    async (_event, raw: unknown): Promise<CommandResponse<CommandName>> => {
      const envelope = z.object({ name: z.string(), input: z.unknown() }).safeParse(raw);
      if (!envelope.success) {
        return fail('Chegou um comando malformado da janela.', z.prettifyError(envelope.error));
      }

      const { name, input } = envelope.data;
      if (!isCommandName(name)) {
        return fail(`Comando desconhecido: ${name}`);
      }

      try {
        const data = await handlers[name](input ?? {});
        const validated = commands[name].output.safeParse(data);
        if (!validated.success) {
          // Bug nosso, nao do usuario: o handler saiu do proprio contrato.
          return fail(
            `O comando ${name} devolveu um resultado fora do contrato.`,
            z.prettifyError(validated.error),
          );
        }
        return { ok: true, data: validated.data };
      } catch (error) {
        if (error instanceof z.ZodError) {
          return fail(`Dados invalidos para o comando ${name}.`, z.prettifyError(error));
        }
        return fail(
          error instanceof Error ? error.message : `O comando ${name} falhou.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    },
  );
}

export function unregisterIpc(): void {
  ipcMain.removeHandler(IPC_CHANNELS.command);
}

function fail(message: string, detail?: string): { ok: false; error: CommandFailure } {
  return { ok: false, error: { message, ...(detail === undefined ? {} : { detail }) } };
}
