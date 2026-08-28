import { budgetSchema, type AgentId, type Budget, type TaskId } from '@office/protocol';

export type BudgetKind = 'turns' | 'time';

export interface BudgetUsage {
  readonly agentId: AgentId;
  readonly turns: number;
  readonly elapsedMs: number;
  /** Assinatura da ultima acao e quantas vezes seguidas ela se repetiu. */
  readonly lastSignature: string | null;
  readonly repeats: number;
}

export type BudgetVerdict =
  | { readonly status: 'ok' }
  | { readonly status: 'warning'; readonly kind: BudgetKind; readonly used: number; readonly limit: number }
  | { readonly status: 'exceeded'; readonly kind: BudgetKind; readonly used: number; readonly limit: number }
  /** Mesma acao tentada de novo: continuar as cegas nao vai resolver. */
  | { readonly status: 'looping'; readonly signature: string; readonly occurrences: number };

/**
 * Limites duros por execucao. Estourou o orcamento ou detectou repeticao, para
 * e pergunta -- nunca segue tentando.
 */
export interface BudgetTracker {
  start(agentId: AgentId, budget: Budget, taskId?: TaskId): void;
  /** Registra um turno e a assinatura da acao tentada. */
  record(agentId: AgentId, signature: string): BudgetVerdict;
  /** Sem gastar turno: so o relogio. Um agente parado tambem estoura. */
  check(agentId: AgentId): BudgetVerdict;
  /**
   * O que sobra para a proxima tentativa. Uma subtask que falhou no portao e
   * tentou de novo nao ganha o orcamento inteiro outra vez -- senao "trinta
   * turnos" viraria "trinta turnos por tentativa", que nao e teto nenhum.
   */
  remaining(agentId: AgentId): Budget;
  usage(agentId: AgentId): BudgetUsage | null;
  release(agentId: AgentId): void;
}

/** A partir de que fracao do teto o aviso sai. O mesmo valor que as CLIs usam. */
const WARN_AT = 0.8;

interface Entry {
  readonly budget: Budget;
  readonly startedAt: number;
  readonly taskId?: TaskId;
  turns: number;
  lastSignature: string | null;
  repeats: number;
  /** Cada aviso sai uma vez so: repetido, vira ruido e para de ser aviso. */
  warnedTurns: boolean;
  warnedTime: boolean;
  reportedLoop: string | null;
}

/**
 * O contador que vive enquanto a execucao vive. Nao emite evento e nao conhece
 * agente: recebe uma assinatura de acao e devolve um veredito. Quem traduz
 * veredito em evento -- e em pergunta -- e quem esta coordenando.
 */
export class InMemoryBudgetTracker implements BudgetTracker {
  private readonly entries = new Map<AgentId, Entry>();

  /** O relogio entra por fora para o teste de tempo nao precisar esperar. */
  constructor(private readonly now: () => number = Date.now) {}

  start(agentId: AgentId, budget: Budget, taskId?: TaskId): void {
    this.entries.set(agentId, {
      budget,
      startedAt: this.now(),
      ...(taskId === undefined ? {} : { taskId }),
      turns: 0,
      lastSignature: null,
      repeats: 0,
      warnedTurns: false,
      warnedTime: false,
      reportedLoop: null,
    });
  }

  record(agentId: AgentId, signature: string): BudgetVerdict {
    const entry = this.entries.get(agentId);
    // Agente sem orcamento aberto nao e erro: e a fila manual, que nao passou
    // por `start`. Sem teto declarado nao ha teto a cobrar.
    if (entry === undefined) return { status: 'ok' };

    entry.turns += 1;
    if (signature === entry.lastSignature) entry.repeats += 1;
    else {
      entry.lastSignature = signature;
      entry.repeats = 1;
    }

    if (entry.repeats > entry.budget.maxRepeats && entry.reportedLoop !== signature) {
      entry.reportedLoop = signature;
      return { status: 'looping', signature, occurrences: entry.repeats };
    }

    return this.verdict(entry);
  }

  check(agentId: AgentId): BudgetVerdict {
    const entry = this.entries.get(agentId);
    return entry === undefined ? { status: 'ok' } : this.verdict(entry);
  }

  private verdict(entry: Entry): BudgetVerdict {
    const { maxTurns, maxDurationMs } = entry.budget;
    const elapsed = this.now() - entry.startedAt;

    if (entry.turns >= maxTurns) {
      return { status: 'exceeded', kind: 'turns', used: entry.turns, limit: maxTurns };
    }
    if (elapsed >= maxDurationMs) {
      return { status: 'exceeded', kind: 'time', used: elapsed, limit: maxDurationMs };
    }
    if (!entry.warnedTurns && entry.turns >= Math.floor(maxTurns * WARN_AT)) {
      entry.warnedTurns = true;
      return { status: 'warning', kind: 'turns', used: entry.turns, limit: maxTurns };
    }
    if (!entry.warnedTime && elapsed >= maxDurationMs * WARN_AT) {
      entry.warnedTime = true;
      return { status: 'warning', kind: 'time', used: elapsed, limit: maxDurationMs };
    }
    return { status: 'ok' };
  }

  remaining(agentId: AgentId): Budget {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return budgetSchema.parse({});

    const elapsed = this.now() - entry.startedAt;
    return budgetSchema.parse({
      // Nunca zero: um orcamento zerado faria a CLI recusar antes do primeiro
      // turno, e o agente pareceria quebrado em vez de sem orcamento.
      maxTurns: Math.max(1, entry.budget.maxTurns - entry.turns),
      maxDurationMs: Math.max(1_000, entry.budget.maxDurationMs - elapsed),
      maxRepeats: entry.budget.maxRepeats,
    });
  }

  usage(agentId: AgentId): BudgetUsage | null {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return null;
    return {
      agentId,
      turns: entry.turns,
      elapsedMs: this.now() - entry.startedAt,
      lastSignature: entry.lastSignature,
      repeats: entry.repeats,
    };
  }

  release(agentId: AgentId): void {
    this.entries.delete(agentId);
  }
}
