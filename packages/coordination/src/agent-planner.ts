import {
  budgetSchema,
  newAgentId,
  newGateId,
  newPlanId,
  parsePlan,
  parsePlanDraft,
  type AgentId,
  type AnyEventDraft,
  type Plan,
  type PlanDraft,
  type RoleDefinition,
} from '@office/protocol';
import type { AgentAdapter } from '@office/agents';
import { parseJsonLoosely } from './extract-json';
import { buildPlanPrompt, type PromptInput } from './prompt';
import type { PlanRequest, PlanResult, Planner } from './planner';

/**
 * Planejar e tarefa curta e limitada: ler o projeto e responder. O orcamento
 * padrao de subtask (15 minutos) so serviria para segurar uma falha por muito
 * mais tempo do que ela merece.
 */
const PLANNING_BUDGET = budgetSchema.parse({ maxTurns: 40, maxDurationMs: 180_000 });

export interface AgentPlannerOptions {
  /** A CLI que roda o gerente. Qual delas e configuracao, nunca constante. */
  readonly adapter: AgentAdapter;
  /** O papel com autoridade para planejar, vindo do roster. */
  readonly role: RoleDefinition;
  /**
   * Para onde vao os eventos do gerente. O planner emite `tool.call` como
   * qualquer agente -- e assim que o hub mostra o gerente lendo o repositorio.
   * Ausente, os eventos sao descartados (e o que o harness faz).
   */
  readonly emit?: (event: AnyEventDraft) => void;
}

/**
 * O gerente rodando numa CLI de verdade.
 *
 * Nao ha runtime de agente aqui e nao se chama API de modelo: e o mesmo
 * `AgentAdapter` que executa uma subtask, com duas diferencas que importam --
 * ele roda em **modo somente-leitura** (planejar nao mexe em arquivo) e a
 * resposta dele e parseada como JSON em vez de aceita como texto.
 */
export class AgentPlanner implements Planner {
  constructor(private readonly options: AgentPlannerOptions) {}

  /**
   * O ultimo pedido, guardado para o replanejamento. `revise` so recebe o plano
   * e o motivo, mas planejar de novo precisa da pasta, do roster e dos portoes
   * -- e inventar isso daria um plano montado contra um projeto imaginario.
   */
  private last: PlanRequest | null = null;

  plan(request: PlanRequest): Promise<PlanResult> {
    this.last = request;
    return this.attempt(request, {
      goal: request.goal,
      roster: request.roster,
      project: request.project,
    });
  }

  revise(plan: Plan, reason: string): Promise<PlanResult> {
    const request = this.last;
    if (request === null) {
      throw new Error('revise() antes de plan(): nao sei contra qual projeto replanejar');
    }
    // Replanejar e planejar de novo sabendo o que deu errado: mesmo caminho,
    // mesmo parse, mesma validacao de grafo.
    return this.attempt(
      request,
      {
        goal: plan.goal,
        roster: request.roster,
        project: request.project,
        previous: { plan, reason },
      },
      plan.revision + 1,
    );
  }

  private async attempt(
    request: PlanRequest,
    prompt: PromptInput,
    revision = 0,
  ): Promise<PlanResult> {
    const first = await this.ask(request, buildPlanPrompt(prompt));
    if (first.kind !== 'answer') return first.result;

    const parsed = this.toPlan(request, first.text, revision);
    if (parsed.kind === 'ok') return { status: 'planned', plan: parsed.plan };

    // JSON fora do schema e o erro que o proprio modelo conserta quando ve o
    // que faltou. Uma segunda chance, com o problema colado -- nunca um loop.
    const second = await this.ask(
      request,
      buildPlanPrompt({ ...prompt, rejected: { answer: first.text, problem: parsed.problem } }),
    );
    if (second.kind !== 'answer') return second.result;

    const retried = this.toPlan(request, second.text, revision);
    if (retried.kind === 'ok') return { status: 'planned', plan: retried.plan };

    return {
      status: 'needs_input',
      question: 'Nao consegui dividir esse pedido em passos. Consegue descrever com mais detalhe o que quer?',
      context: 'Tentei duas vezes e o plano saiu incompleto das duas.',
    };
  }

  /** Roda a CLI e devolve o texto final, ou o `PlanResult` que ja fecha o caso. */
  private async ask(
    request: PlanRequest,
    prompt: string,
  ): Promise<
    | { readonly kind: 'answer'; readonly text: string }
    | { readonly kind: 'done'; readonly result: PlanResult }
  > {
    const { adapter, role, emit } = this.options;
    const agentId: AgentId = newAgentId(role.id);

    const run = adapter.start({
      agentId,
      role: role.id,
      displayName: role.title,
      cwd: request.project.path,
      prompt,
      allowedPaths: [],
      contracts: [],
      // Planejar e olhar. Sem isto o gerente teria permissao de escrita sobre a
      // pasta inteira do usuario so para decidir o que fazer.
      readOnly: true,
      budget: PLANNING_BUDGET,
      ...(role.model === undefined ? {} : { model: role.model }),
    });

    /**
     * O adaptador **nunca** devolve `blocked` no desfecho: bloqueio chega como
     * evento, e a CLI fica suspensa ate alguem chamar `answer`. Aqui nao ha
     * quem responda -- o gerente ainda esta decidindo o que fazer, e nao existe
     * conversa aberta com a pessoa. Sem tratar isso a execucao ficaria
     * pendurada ate estourar o orcamento.
     *
     * Mas as duas causas se leem de formas opostas, e `cause` e quem separa:
     *
     * - `agent_asked` e o gerente perguntando de verdade. Vira `needs_input`.
     * - qualquer outra e a **nossa** politica barrando ele -- tipicamente um
     *   `Bash` em modo somente-leitura. Isso nao e pergunta para a pessoa:
     *   e o gerente tentando sair do combinado. Recusamos e ele segue
     *   planejando com o que da para ler.
     *
     * Tratar as duas igual jogava o texto cru da ferramenta ("Rodando: which
     * codex ...") na tela como se fosse duvida de produto.
     */
    let asked: { question: string; context: string } | null = null;

    for await (const event of run) {
      emit?.(event);
      if (event.type !== 'human.question_raised' || asked !== null) continue;

      if (event.payload.cause === 'agent_asked') {
        asked = { question: event.payload.question, context: event.payload.context };
        run.cancel('O gerente perguntou antes de dividir o trabalho.');
      } else {
        run.answer('Para planejar, leia os arquivos em vez de rodar comandos.', 'deny');
      }
    }

    const outcome = await run.outcome;

    if (asked !== null) {
      // O gerente preferiu perguntar a chutar. E o comportamento certo, nao uma
      // falha: a duvida sobe inteira para a pessoa.
      return { kind: 'done', result: { status: 'needs_input', ...asked } };
    }

    switch (outcome.status) {
      case 'completed':
        return { kind: 'answer', text: outcome.summary };
      case 'blocked':
        return {
          kind: 'done',
          result: {
            status: 'needs_input',
            question: outcome.question,
            context: 'O gerente parou para perguntar antes de dividir o trabalho.',
          },
        };
      case 'cancelled':
      case 'failed':
        return {
          kind: 'done',
          result: {
            status: 'needs_input',
            question: 'Nao consegui montar o plano. Quer tentar de novo?',
            context: outcome.reason,
          },
        };
    }
  }

  /** Rascunho do modelo -> plano completo. Os ids do sistema entram aqui. */
  private toPlan(
    request: PlanRequest,
    text: string,
    revision: number,
  ): { readonly kind: 'ok'; readonly plan: Plan } | { readonly kind: 'bad'; readonly problem: string } {
    const raw = parseJsonLoosely(text);
    if (raw === null) {
      return { kind: 'bad', problem: 'Nao encontrei nenhum objeto JSON na resposta.' };
    }

    const draft = parsePlanDraft(raw);
    if (!draft.ok) return { kind: 'bad', problem: draft.problem };

    const createdBy = newAgentId(this.options.role.id);
    const candidate = {
      id: newPlanId(),
      runId: request.runId,
      revision,
      createdBy,
      goal: request.goal,
      subtasks: withSystemFields(draft.value),
      contracts: draft.value.contracts,
    };

    // O plano completo passa pelo `planSchema` de novo: o rascunho ja validou o
    // grafo, mas quem entra no log e o que este schema aceitou.
    const plan = parsePlan(candidate);
    if (!plan.ok) return { kind: 'bad', problem: plan.problem };
    return { kind: 'ok', plan: plan.value };
  }
}

/** Id de portao e orcamento sao do sistema: o modelo nunca os escolhe. */
function withSystemFields(draft: PlanDraft): Plan['subtasks'] {
  const budget = budgetSchema.parse({});
  return draft.subtasks.map((subtask) => ({
    ...subtask,
    gate: { ...subtask.gate, id: newGateId() },
    budget,
  }));
}
