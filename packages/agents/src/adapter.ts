import type {
  AdapterId,
  AgentId,
  AnyEventDraft,
  Budget,
  QuestionId,
  RoleId,
  TaskId,
} from '@office/protocol';

/**
 * O que uma CLI de agente sabe fazer. O orquestrador consulta isto antes de
 * montar o plano: um adaptador que nao retoma sessao nao pode receber uma
 * subtask que depende de responder pergunta no meio do caminho.
 */
export interface AdapterCapabilities {
  /** Emite JSON linha a linha em vez de texto corrido. */
  readonly streamsJson: boolean;
  /** Consegue continuar uma sessao anterior pelo id. */
  readonly resumesSession: boolean;
  /** Aceita diretorios extras alem do cwd. */
  readonly acceptsExtraDirs: boolean;
  /** Reporta chamadas de ferramenta individualmente (vira `tool.call`). */
  readonly reportsToolCalls: boolean;
}

/**
 * Resultado de verificar se a CLI existe e esta utilizavel. Nao lanca: CLI
 * ausente ou sem login e situacao esperada, e o hub precisa mostrar isso ao
 * usuario como um estado, nao como uma exception.
 */
export type AdapterProbe =
  | { readonly available: true; readonly version: string; readonly executable: string }
  | { readonly available: false; readonly reason: string };

export interface AgentRunRequest {
  readonly agentId: AgentId;
  readonly role: RoleId;
  /** Subtask sendo executada. Vai nos eventos que o adaptador emite. */
  readonly taskId?: TaskId;
  /** Alias de modelo repassado a CLI. Ausente = default da propria CLI. */
  readonly model?: string;
  /** Worktree do agente. Dois agentes nunca recebem o mesmo caminho. */
  readonly cwd: string;
  /** Instrucao em linguagem natural, ja montada pelo gerente. */
  readonly prompt: string;
  /** Areas que a subtask pode tocar. Vazio = sem restricao. */
  readonly allowedPaths: readonly string[];
  /** Contratos que entram como input obrigatorio, ja resolvidos em texto. */
  readonly contracts: readonly string[];
  readonly budget: Budget;
  /** Retomada de sessao anterior. Ambas as CLIs suportam. */
  readonly sessionId?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type AgentOutcome =
  | {
      readonly status: 'completed';
      readonly summary: string;
      readonly turns: number;
      /** Guardado para retomar esta mesma conversa depois. */
      readonly sessionId?: string;
    }
  | {
      /** Parou e precisa do humano. O orquestrador escala e depois chama `answer`. */
      readonly status: 'blocked';
      readonly questionId: QuestionId;
      readonly question: string;
      readonly sessionId?: string;
    }
  | {
      readonly status: 'failed';
      /** Frase para o usuario. Nunca stack trace. */
      readonly reason: string;
      readonly detail?: string;
      readonly exitCode?: number;
    }
  | { readonly status: 'cancelled'; readonly reason: string };

/**
 * Uma execucao em andamento. Os eventos saem pelo async iterator e o desfecho
 * pela promise; consumir os dois e responsabilidade do orquestrador.
 */
export interface AgentRun extends AsyncIterable<AnyEventDraft> {
  readonly agentId: AgentId;
  /**
   * Entrega a resposta do humano e retoma de onde parou. `optionId` e o id da
   * opcao escolhida -- num pedido de permissao ele e `allow` ou `deny`, e e o
   * que separa autorizar de recusar com uma explicacao.
   */
  answer(answer: string, optionId?: string): void;
  /** Encerra o subprocesso. Idempotente. */
  cancel(reason: string): void;
  readonly outcome: Promise<AgentOutcome>;
}

/**
 * Ponte entre uma CLI instalada no terminal do usuario e o dominio. O
 * orquestrador nao conhece flags, formatos de stream nem nomes de modelo:
 * conhece esta interface.
 */
export interface AgentAdapter {
  readonly id: AdapterId;
  readonly capabilities: AdapterCapabilities;
  /** Nome exibido no hub ("Claude Code", "Kimi"). */
  readonly displayName: string;
  probe(): Promise<AdapterProbe>;
  start(request: AgentRunRequest): AgentRun;
}

/** Registro de adaptadores disponiveis, indexado pelo id declarado no roster. */
export interface AdapterRegistry {
  get(id: AdapterId): AgentAdapter | undefined;
  list(): readonly AgentAdapter[];
}

export function createAdapterRegistry(adapters: readonly AgentAdapter[]): AdapterRegistry {
  const byId = new Map<string, AgentAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`adaptador duplicado: ${adapter.id}`);
    }
    byId.set(adapter.id, adapter);
  }
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
  };
}
