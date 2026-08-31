import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  draft,
  newAgentId,
  newQuestionId,
  newRunId,
  newTaskId,
  type AnyEventDraft,
  type RunId,
} from '@hive/protocol';
import { AppStore, CorruptEventError, EventStore, InvalidEventError, openDatabase, type Db } from '../src/index';

let db: Db;
let store: EventStore;
let runId: RunId;

const manager = newAgentId('gerente');
const worker = newAgentId('backend');

const started = (): AnyEventDraft =>
  draft('run.started', { projectPath: '/tmp/projeto', goal: 'Tela de login', startedBy: 'human' });

const message = (text: string): AnyEventDraft =>
  draft('agent.message', { from: manager, to: worker, intent: 'inform', summary: text });

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  store = new EventStore(db);
  runId = store.createRun({ projectPath: '/tmp/projeto', goal: 'Tela de login' });
});

afterEach(() => {
  db.close();
});

describe('ciclo de vida da execucao', () => {
  it('cria a execucao em running e conta eventos', () => {
    const summary = store.getRun(runId);
    expect(summary?.status).toBe('running');
    expect(summary?.eventCount).toBe(0);

    store.append(runId, started());
    expect(store.getRun(runId)?.eventCount).toBe(1);
  });

  it('marca a execucao como concluida', () => {
    store.finishRun(runId, 'completed', 123);
    const summary = store.getRun(runId);
    expect(summary?.status).toBe('completed');
    expect(summary?.endedAt).toBe(123);
  });

  it('recusa fechar execucao inexistente', () => {
    expect(() => store.finishRun(newRunId(), 'failed')).toThrow(/execucao desconhecida/);
  });

  it('lista execucoes do projeto da mais recente para a mais antiga', () => {
    // Projeto proprio: a execucao criada no beforeEach usa Date.now() e ficaria
    // sempre no topo, escondendo o que este teste quer medir.
    store.createRun({ projectPath: '/tmp/outro-projeto', goal: 'Antiga', startedAt: 1000 });
    store.createRun({ projectPath: '/tmp/outro-projeto', goal: 'Recente', startedAt: 9000 });
    store.createRun({ projectPath: '/tmp/projeto', goal: 'De outro projeto', startedAt: 5000 });

    const runs = store.listRuns('/tmp/outro-projeto');
    expect(runs.map((run) => run.goal)).toEqual(['Recente', 'Antiga']);
  });
});

describe('append', () => {
  it('atribui seq comecando em 1, sem buracos', () => {
    const first = store.append(runId, started());
    const second = store.append(runId, message('comecando'));
    const third = store.append(runId, message('continuando'));

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(store.lastSeq(runId)).toBe(3);
  });

  it('sela o envelope com id unico e versao de schema', () => {
    const a = store.append(runId, started());
    const b = store.append(runId, message('oi'));
    expect(a.id).not.toBe(b.id);
    expect(a.schemaVersion).toBe(1);
    expect(a.runId).toBe(runId);
  });

  it('numera execucoes independentes de forma independente', () => {
    const other = store.createRun({ projectPath: '/tmp/projeto', goal: 'Outra' });
    store.append(runId, started());
    store.append(runId, message('a'));
    const first = store.append(other, started());

    expect(first.seq).toBe(1);
    expect(store.lastSeq(runId)).toBe(2);
  });

  it('recusa o lote inteiro quando um draft e invalido', () => {
    store.append(runId, started());
    // `agent.message` sem `to`, `intent` e `summary`. Nao pode entrar no log nem
    // deixar o lote pela metade: o replay de meses depois depende disso.
    const invalid = JSON.parse(JSON.stringify({ type: 'agent.message', payload: { from: manager } }));

    expect(() => store.appendMany(runId, [message('ok'), invalid, message('tambem ok')])).toThrow(
      InvalidEventError,
    );
    expect(store.lastSeq(runId)).toBe(1);
    expect(store.read(runId).map((event) => event.type)).toEqual(['run.started']);
  });

  it('aponta a posicao do draft ruim dentro do lote', () => {
    store.append(runId, started());
    const invalid = JSON.parse(JSON.stringify({ type: 'run.failed', payload: {} }));
    try {
      store.appendMany(runId, [message('a'), message('b'), invalid]);
      throw new Error('esperava InvalidEventError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEventError);
      if (error instanceof InvalidEventError) expect(error.index).toBe(2);
    }
  });

  it('recusa tipo de evento fora do catalogo', () => {
    const alien = JSON.parse(JSON.stringify({ type: 'run.exploded', payload: {} }));
    expect(() => store.appendMany(runId, [alien])).toThrow(InvalidEventError);
  });

  it('recusa append em execucao desconhecida', () => {
    expect(() => store.append(newRunId(), started())).toThrow(/execucao desconhecida/);
  });

  it('devolve lista vazia para lote vazio', () => {
    expect(store.appendMany(runId, [])).toEqual([]);
  });
});

describe('leitura e replay', () => {
  const povoar = (quantidade: number) => {
    store.append(runId, started());
    for (let i = 0; i < quantidade; i += 1) {
      store.append(runId, message(`passo ${i}`));
    }
  };

  it('le a partir de um seq, em ordem', () => {
    povoar(4);
    const tail = store.read(runId, 2);
    expect(tail.map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  it('devolve vazio quando nao ha nada novo', () => {
    povoar(2);
    expect(store.read(runId, 3)).toEqual([]);
  });

  it('reproduz a execucao inteira em ordem, atravessando lotes', () => {
    povoar(1200);
    const seqs = [...store.replay(runId, 100)].map((event) => event.seq);
    expect(seqs).toHaveLength(1201);
    expect(seqs[0]).toBe(1);
    expect(seqs[seqs.length - 1]).toBe(1201);
    expect(seqs.every((seq, index) => seq === index + 1)).toBe(true);
  });

  it('preserva o payload atraves do roundtrip', () => {
    const questionId = newQuestionId();
    store.append(runId, started());
    store.append(
      runId,
      draft('human.question_raised', {
        questionId,
        question: 'Posso usar o banco que ja existe?',
        context: 'Encontrei duas conexoes configuradas no projeto.',
        options: [{ id: 'sim', label: 'Sim' }],
      }),
    );

    const [, question] = store.read(runId);
    expect(question?.type).toBe('human.question_raised');
    if (question?.type === 'human.question_raised') {
      expect(question.payload.questionId).toBe(questionId);
      expect(question.payload.options[0]?.label).toBe('Sim');
      expect(question.payload.allowFreeText).toBe(true);
    }
  });

  it('preserva quem atribuiu e para quem', () => {
    store.append(runId, started());
    store.append(
      runId,
      draft('task.assigned', {
        taskId: newTaskId(),
        title: 'Criar a rota',
        role: 'backend',
        assignedBy: manager,
        assignedTo: worker,
      }),
    );

    const [, assigned] = store.read(runId);
    if (assigned?.type === 'task.assigned') {
      expect(assigned.payload.assignedBy).toBe(manager);
      expect(assigned.payload.assignedTo).toBe(worker);
    } else {
      throw new Error('esperava task.assigned');
    }
  });
});

describe('closeRun', () => {
  it('grava o evento terminal e fecha a execucao de uma vez so', () => {
    store.append(runId, started());
    const sealed = store.closeRun(
      runId,
      draft('run.completed', { summary: 'pronto', durationMs: 10, tasksCompleted: 1 }),
      'completed',
      777,
    );

    expect(sealed.seq).toBe(2);
    const summary = store.getRun(runId);
    expect(summary?.status).toBe('completed');
    expect(summary?.endedAt).toBe(777);
  });

  it('nao fecha a execucao se o evento terminal for invalido', () => {
    store.append(runId, started());
    const invalid = JSON.parse(JSON.stringify({ type: 'run.completed', payload: {} }));

    expect(() => store.closeRun(runId, invalid, 'completed')).toThrow();
    expect(store.getRun(runId)?.status).toBe('running');
    expect(store.lastSeq(runId)).toBe(1);
  });
});

describe('integridade do log', () => {
  it('recusa UPDATE em events', () => {
    store.append(runId, started());
    expect(() => db.prepare(`UPDATE events SET type = 'run.failed' WHERE seq = 1`).run()).toThrow(
      /append-only/,
    );
  });

  it('recusa DELETE em events', () => {
    store.append(runId, started());
    expect(() => db.prepare(`DELETE FROM events WHERE seq = 1`).run()).toThrow(/append-only/);
  });

  it('aponta run e seq quando a linha esta corrompida', () => {
    store.append(runId, started());
    db.prepare(`UPDATE runs SET goal = goal`).run();
    db.exec(`DROP TRIGGER events_are_immutable`);
    db.prepare(`UPDATE events SET payload = '{"nada":1}' WHERE seq = 1`).run();

    expect(() => store.read(runId)).toThrow(CorruptEventError);
    try {
      store.read(runId);
    } catch (error) {
      expect(error).toBeInstanceOf(CorruptEventError);
      if (error instanceof CorruptEventError) {
        expect(error.seq).toBe(1);
        expect(error.runId).toBe(runId);
      }
    }
  });
});

describe('AppStore', () => {
  it('mantem os recentes do mais novo para o mais velho', () => {
    const app = new AppStore(db);
    app.rememberProject('/tmp/projeto-a', 1000);
    app.rememberProject('/tmp/projeto-b', 2000);
    app.rememberProject('/tmp/projeto-a', 3000);

    const recentes = app.recentProjects();
    expect(recentes.map((p) => p.path)).toEqual(['/tmp/projeto-a', '/tmp/projeto-b']);
    expect(recentes[0]?.name).toBe('projeto-a');
  });

  it('marca pasta que sumiu do disco em vez de esconde-la', () => {
    const app = new AppStore(db);
    app.rememberProject('/tmp', 1000);
    app.rememberProject('/tmp/pasta-que-nao-existe-1234', 2000);

    const recentes = app.recentProjects();
    expect(recentes[0]?.exists).toBe(false);
    expect(recentes[1]?.exists).toBe(true);
  });

  it('esquece uma pasta e informa se havia algo para esquecer', () => {
    const app = new AppStore(db);
    app.rememberProject('/tmp/projeto-a');
    expect(app.forgetProject('/tmp/projeto-a')).toBe(true);
    expect(app.forgetProject('/tmp/projeto-a')).toBe(false);
    expect(app.recentProjects()).toEqual([]);
  });
});
