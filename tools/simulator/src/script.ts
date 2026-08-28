import {
  draft,
  newAgentId,
  newContractId,
  newGateId,
  newPlanId,
  newQuestionId,
  newTaskId,
  planSchema,
  type AgentId,
  type AgentState,
  type AnyEventDraft,
  type Plan,
  type QuestionId,
  type RunId,
  type TaskId,
} from '@office/protocol';

/**
 * Roteiro de uma execucao plausivel: o gerente decompoe, publica o contrato que
 * liga as duas frentes paralelas, os especialistas trabalham, um deles trava
 * numa duvida de produto e a execucao so segue depois que o humano responde.
 */
export interface ScriptedRun {
  readonly plan: Plan;
  readonly manager: AgentId;
  readonly frontend: AgentId;
  readonly backend: AgentId;
  readonly questionId: QuestionId;
  /** Ate o bloqueio. */
  readonly beforeBlock: readonly AnyEventDraft[];
  /** Depois que `human.answered` entrar no log. */
  readonly afterAnswer: readonly AnyEventDraft[];
}

export function buildScriptedRun(runId: RunId, projectPath: string, goal: string): ScriptedRun {
  const manager = newAgentId('gerente');
  const frontend = newAgentId('frontend');
  const backend = newAgentId('backend');

  const contractId = newContractId();
  const apiTask = newTaskId();
  const uiTask = newTaskId();
  const joinTask = newTaskId();
  const questionId = newQuestionId();

  const gate = (kind: 'typecheck' | 'test' | 'build', command: string) => ({
    id: newGateId(),
    kind,
    command,
    cwd: '.',
    timeoutMs: 300_000,
  });

  const apiGate = gate('test', 'pnpm test --filter api');
  const uiGate = gate('typecheck', 'pnpm typecheck');
  const joinGate = gate('build', 'pnpm build');

  const contract = {
    id: contractId,
    kind: 'types' as const,
    title: 'Contrato da sessao de login',
    body: 'type Credenciais = { email: string; senha: string }\ntype Sessao = { token: string; expiraEm: number }\nPOST /api/sessao -> Sessao',
    path: 'contracts/sessao.md',
  };

  // Contrato antes de paralelismo: as duas subtasks paralelas o recebem como
  // input obrigatorio, e a terceira so comeca quando as duas fecham.
  const plan = planSchema.parse({
    id: newPlanId(),
    runId,
    revision: 0,
    createdBy: manager,
    goal,
    contracts: [contract],
    subtasks: [
      {
        id: apiTask,
        title: 'Rota de login',
        description: 'Criar POST /api/sessao validando email e senha e devolvendo o token.',
        role: 'backend',
        dependsOn: [],
        allowedPaths: ['src/api'],
        inputContracts: [contractId],
        doneWhen: 'A rota responde com o token e os testes dela passam.',
        modelTier: 'padrao',
        modelReason: 'mexe numa area so, mas dois passos dependem dela',
        gate: apiGate,
        budget: { maxTurns: 30, maxDurationMs: 900_000, maxRepeats: 2 },
      },
      {
        id: uiTask,
        title: 'Tela de login',
        description: 'Montar o formulario de email e senha consumindo o contrato da sessao.',
        role: 'frontend',
        dependsOn: [],
        allowedPaths: ['src/telas'],
        inputContracts: [contractId],
        doneWhen: 'A tela envia o formulario e mostra o erro quando a senha nao confere.',
        modelTier: 'economico',
        modelReason: 'mexe numa area so e ninguem depende dela',
        gate: uiGate,
        budget: { maxTurns: 30, maxDurationMs: 900_000, maxRepeats: 2 },
      },
      {
        id: joinTask,
        title: 'Ligar tela e rota',
        description: 'Integrar as duas frentes e guardar a sessao entre recarregamentos.',
        role: 'revisao',
        dependsOn: [apiTask, uiTask],
        allowedPaths: [],
        inputContracts: [contractId],
        doneWhen: 'Entrar e sair funciona e o build passa.',
        modelTier: 'caprichado',
        modelReason: 'junta o trabalho de dois passos e toca varias areas',
        gate: joinGate,
        budget: { maxTurns: 30, maxDurationMs: 900_000, maxRepeats: 2 },
      },
    ],
  });

  const spawn = (agentId: AgentId, role: string, displayName: string, adapter: string, model?: string) =>
    draft('agent.spawned', {
      agentId,
      role,
      displayName,
      adapter,
      ...(model === undefined ? {} : { model }),
      worktreePath: `${projectPath}/.office/worktrees/${role}`,
      branch: `office/${role}`,
    });

  /**
   * O consumo de um agente, um evento por modelo -- como a CLI de verdade
   * reporta. Os numeros sao da ordem de grandeza medida em
   * `tools/planner-lab/BASELINE.md`; o roteiro nao inventa desconto.
   *
   * O agente do Kimi nao emite nenhum, de proposito: o ACP dele nao reporta
   * consumo, e o roteiro existe para mostrar o fluxo como ele e. Zerar ali se
   * leria como "foi de graca", que e a unica coisa que este numero nao pode
   * dizer.
   */
  const usage = (
    agentId: AgentId,
    model: string,
    costUsd: number,
    tokens: { input: number; output: number; cacheWrite: number; cacheRead: number },
    task?: TaskId,
  ) =>
    draft('agent.usage', {
      agentId,
      ...(task === undefined ? {} : { taskId: task }),
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheWrite,
      cacheReadTokens: tokens.cacheRead,
      costUsd,
    });

  const state = (agentId: AgentId, from: AgentState, to: AgentState, reason?: string) =>
    draft('agent.state_changed', { agentId, from, to, ...(reason ? { reason } : {}) });

  const beforeBlock: AnyEventDraft[] = [
    draft('run.started', { projectPath, goal, startedBy: 'human' }),
    spawn(manager, 'gerente', 'Gerente', 'claude', 'opus'),
    state(manager, 'idle', 'thinking', 'Lendo o pedido e olhando o projeto'),
    draft('plan.created', { plan, createdBy: manager }),
    // Planejar custa, e o gasto do gerente conta como o de qualquer outro. Dois
    // eventos porque uma unica execucao da CLI mistura modelos: ela usa um
    // barato para trabalho interno dela.
    usage(manager, 'claude-opus-4-6', 0.2417, { input: 12, output: 3_180, cacheWrite: 8_902, cacheRead: 41_355 }),
    usage(manager, 'claude-haiku-4-5', 0.0061, { input: 340, output: 210, cacheWrite: 0, cacheRead: 2_140 }),
    state(manager, 'thinking', 'talking', 'Publicando o contrato antes de dividir'),
    draft('contract.published', { contract, publishedBy: manager, unblocks: [apiTask, uiTask] }),

    spawn(backend, 'backend', 'Backend', 'claude', 'sonnet'),
    // Sem alias: o papel do Kimi nao declara escada, entao roda no padrao da CLI.
    spawn(frontend, 'frontend', 'Interface e 3D', 'kimi'),

    draft('task.assigned', {
      taskId: apiTask, title: 'Rota de login', role: 'backend',
      assignedBy: manager, assignedTo: backend, dependsOn: [],
    }),
    draft('agent.handoff', { from: manager, to: backend, taskId: apiTask, artifact: 'contracts/sessao.md' }),
    draft('task.assigned', {
      taskId: uiTask, title: 'Tela de login', role: 'frontend',
      assignedBy: manager, assignedTo: frontend, dependsOn: [],
    }),
    draft('agent.handoff', { from: manager, to: frontend, taskId: uiTask, artifact: 'contracts/sessao.md' }),
    state(manager, 'talking', 'idle', 'Esperando as duas frentes'),

    draft('task.started', { taskId: apiTask, agentId: backend, title: 'Rota de login' }),
    state(backend, 'idle', 'working'),
    draft('task.started', { taskId: uiTask, agentId: frontend, title: 'Tela de login' }),
    state(frontend, 'idle', 'working'),

    draft('tool.call', { agentId: backend, taskId: apiTask, callId: 'call_api_1', tool: 'Write', target: 'src/api/sessao.ts', summary: 'Criando a rota de sessao' }),
    draft('tool.result', { agentId: backend, taskId: apiTask, callId: 'call_api_1', tool: 'Write', ok: true, summary: 'Rota criada' }),
    draft('file.changed', { agentId: backend, taskId: apiTask, path: 'src/api/sessao.ts', change: 'created', linesAdded: 84, linesRemoved: 0 }),
    draft('tool.call', { agentId: frontend, taskId: uiTask, callId: 'call_ui_1', tool: 'Write', target: 'src/telas/Login.tsx', summary: 'Montando o formulario' }),
    draft('tool.result', { agentId: frontend, taskId: uiTask, callId: 'call_ui_1', tool: 'Write', ok: true, summary: 'Formulario criado' }),
    draft('file.changed', { agentId: frontend, taskId: uiTask, path: 'src/telas/Login.tsx', change: 'created', linesAdded: 120, linesRemoved: 0 }),
    draft('task.progress', { taskId: apiTask, agentId: backend, note: 'Rota criada, escrevendo os testes', ratio: 0.6 }),

    draft('gate.started', { gateId: apiGate.id, taskId: apiTask, agentId: backend, kind: 'test', command: apiGate.command }),
    draft('gate.passed', { gateId: apiGate.id, taskId: apiTask, agentId: backend, kind: 'test', durationMs: 4200 }),
    usage(backend, 'claude-sonnet-4-5', 0.0839, { input: 6, output: 4_412, cacheWrite: 6_744, cacheRead: 28_295 }, apiTask),
    draft('task.completed', { taskId: apiTask, agentId: backend, summary: 'Rota de login pronta e testada', filesChanged: 3 }),
    state(backend, 'working', 'done'),
    draft('worktree.merged', { agentId: manager, taskId: apiTask, branch: 'office/backend', into: 'main', filesChanged: 3 }),

    // O bloqueio: pergunta de produto, nao de codigo. Quem nao le codigo
    // consegue responder, e continuar tentando as cegas nao resolveria.
    draft('agent.message', {
      from: frontend, to: 'human', intent: 'request',
      summary: 'Preciso saber o que fazer quando a pessoa erra a senha varias vezes.',
    }),
    state(frontend, 'working', 'blocked', 'Duvida sobre o comportamento da tela'),
    draft('human.question_raised', {
      questionId,
      question: 'O que a tela deve fazer depois de tres tentativas de senha erradas?',
      context:
        'Precisamos decidir isso agora porque muda o que a tela mostra e o que a rota precisa devolver.',
      askedBy: frontend,
      taskId: uiTask,
      options: [
        { id: 'bloquear', label: 'Bloquear por 5 minutos e avisar na tela' },
        { id: 'captcha', label: 'Pedir a verificacao de "nao sou um robo"' },
        { id: 'nada', label: 'Nao fazer nada por enquanto' },
      ],
      allowFreeText: true,
    }),
  ];

  const afterAnswer: AnyEventDraft[] = [
    state(frontend, 'blocked', 'working', 'Retomando com a resposta'),
    draft('tool.call', { agentId: frontend, taskId: uiTask, callId: 'call_ui_2', tool: 'Edit', target: 'src/telas/Login.tsx', summary: 'Aplicando a decisao na tela' }),
    draft('tool.result', { agentId: frontend, taskId: uiTask, callId: 'call_ui_2', tool: 'Edit', ok: true, summary: 'Decisao aplicada' }),
    draft('file.changed', { agentId: frontend, taskId: uiTask, path: 'src/telas/Login.tsx', change: 'modified', linesAdded: 31, linesRemoved: 4 }),
    draft('gate.started', { gateId: uiGate.id, taskId: uiTask, agentId: frontend, kind: 'typecheck', command: uiGate.command }),
    draft('gate.failed', {
      gateId: uiGate.id, taskId: uiTask, agentId: frontend, kind: 'typecheck', exitCode: 1,
      summary: 'A tela usa um campo que o contrato da sessao nao tem.',
      detail: 'src/telas/Login.tsx(42,18): Property "tentativas" does not exist on type "Sessao".',
    }),
    // Nenhum agente aprova o proprio trabalho: portao vermelho volta para o
    // agente, e so depois de verde a entrega e aceita.
    draft('agent.message', { from: frontend, to: manager, intent: 'warn', summary: 'O portao acusou um campo que o contrato nao tem.' }),
    draft('task.progress', { taskId: uiTask, agentId: frontend, note: 'Corrigindo para respeitar o contrato', ratio: 0.9 }),
    draft('gate.started', { gateId: uiGate.id, taskId: uiTask, agentId: frontend, kind: 'typecheck', command: uiGate.command }),
    draft('gate.passed', { gateId: uiGate.id, taskId: uiTask, agentId: frontend, kind: 'typecheck', durationMs: 3100 }),
    draft('task.completed', { taskId: uiTask, agentId: frontend, summary: 'Tela de login pronta', filesChanged: 2 }),
    state(frontend, 'working', 'done'),
    draft('worktree.merged', { agentId: manager, taskId: uiTask, branch: 'office/frontend', into: 'main', filesChanged: 2 }),

    state(manager, 'idle', 'working', 'Integrando as duas frentes'),
    draft('task.assigned', {
      taskId: joinTask, title: 'Ligar tela e rota', role: 'revisao',
      assignedBy: manager, assignedTo: manager, dependsOn: [apiTask, uiTask],
    }),
    draft('task.started', { taskId: joinTask, agentId: manager, title: 'Ligar tela e rota' }),
    draft('gate.started', { gateId: joinGate.id, taskId: joinTask, agentId: manager, kind: 'build', command: joinGate.command }),
    draft('gate.passed', { gateId: joinGate.id, taskId: joinTask, agentId: manager, kind: 'build', durationMs: 9800 }),
    usage(manager, 'claude-opus-4-6', 0.0912, { input: 8, output: 1_204, cacheWrite: 2_010, cacheRead: 33_770 }, joinTask),
    draft('task.completed', { taskId: joinTask, agentId: manager, summary: 'Entrar e sair funcionando', filesChanged: 1 }),
    state(manager, 'working', 'done'),

    draft('agent.despawned', { agentId: backend, reason: 'finished' }),
    draft('agent.despawned', { agentId: frontend, reason: 'finished' }),
    draft('agent.despawned', { agentId: manager, reason: 'finished' }),
    draft('run.completed', { summary: 'Login pronto: tela, rota e sessao guardada.', durationMs: 187_000, tasksCompleted: 3 }),
  ];

  return { plan, manager, frontend, backend, questionId, beforeBlock, afterAnswer };
}
