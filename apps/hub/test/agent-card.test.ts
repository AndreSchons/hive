import { describe, expect, it } from 'vitest';
import { newRunId, parseEvent, rosterSchema, SCHEMA_VERSION, type AnyEvent } from '@office/protocol';
import { buildScriptedRun } from '@office/simulator';
import { applyAll, emptyWorld } from '../src/state/event-reducer';
import { buildAgentCard, shortModel } from '../src/state/agent-card';

const runId = newRunId();

function seal(drafts: readonly { type: string; payload: unknown }[], from = 0): AnyEvent[] {
  return drafts.map((draft, index) =>
    parseEvent({
      schemaVersion: SCHEMA_VERSION,
      id: `evt_${from + index + 1}`,
      runId,
      seq: from + index + 1,
      ts: 1_700_000_000_000 + index * 1000,
      ...draft,
    }),
  );
}

const CLAUDE_MODELS = { economico: 'haiku', padrao: 'sonnet', caprichado: 'opus' } as const;

/** O mesmo formato do roster real: claude com escada, um adaptador sem. */
const roles = rosterSchema.parse([
  { id: 'gerente', title: 'Gerente', adapter: 'claude', models: CLAUDE_MODELS, canDelegate: true },
  { id: 'backend', title: 'Backend', adapter: 'claude', models: CLAUDE_MODELS, canDelegate: false },
  { id: 'frontend', title: 'Interface e 3D', adapter: 'mock', canDelegate: false },
]);

const script = buildScriptedRun(runId, '/tmp/projeto', 'Adicionar login');
const beforeBlock = seal(script.beforeBlock);
const afterAnswer = seal(script.afterAnswer, beforeBlock.length);
const meio = applyAll(emptyWorld, beforeBlock);
const fim = applyAll(meio, afterAnswer);

const row = (card: { rows: readonly { label: string; value: string; note?: string }[] }, label: string) =>
  card.rows.find((item) => item.label === label);

describe('buildAgentCard', () => {
  it('diz quem e a pessoa e qual ferramenta esta por tras dela', () => {
    const card = buildAgentCard(meio, script.backend, roles);

    expect(card?.displayName).toBe('Backend');
    // Papel e CLI na mesma linha: escolher sem saber qual IA e escolher no escuro.
    expect(card?.subtitle).toContain('Backend');
    expect(card?.subtitle).toContain('Claude Code');
  });

  it('nao inventa ficha para um agente que nao existe', () => {
    expect(buildAgentCard(meio, 'agt_naoexiste', roles)).toBeNull();
  });

  it('mostra o degrau em palavra de produto, com o motivo do plano', () => {
    const capricho = row(buildAgentCard(meio, script.backend, roles)!, 'Capricho');

    // Nunca o nome do modelo: "sonnet" nao diz nada para quem nao le codigo.
    expect(['economico', 'equilibrado', 'caprichado']).toContain(capricho?.value);
    expect(capricho?.note).toBeDefined();
  });

  it('papel sem escada diz que roda no padrao da CLI, em vez de inventar degrau', () => {
    const capricho = row(buildAgentCard(meio, script.frontend, roles)!, 'Capricho');

    expect(capricho?.value).toBe('o padrao desta ferramenta');
  });

  it('soma o gasto do agente e reparte por modelo quando ha mais de um', () => {
    const custo = row(buildAgentCard(meio, script.manager, roles)!, 'Ja custou');

    // O gerente roda dois modelos no roteiro: um caro e um barato para trabalho
    // interno da propria CLI. O total sozinho esconderia de onde saiu o dinheiro.
    expect(custo?.value).toMatch(/^US\$ /);
    expect(custo?.note).toContain('opus');
    expect(custo?.note).toContain('haiku');
  });

  it('CLI que nao reporta consumo aparece como ausente, nunca como zero', () => {
    const custo = row(buildAgentCard(fim, script.frontend, roles)!, 'Ja custou');

    expect(custo?.value).toBe('esta ferramenta nao informa o custo');
    expect(custo?.value).not.toContain('0,00');
  });

  it('quem ja entregou conta o que entregou, em vez de sumir da ficha', () => {
    const agora = row(buildAgentCard(fim, script.backend, roles)!, 'Agora');

    expect(agora?.value).toBe('descansando no lounge');
    expect(agora?.note).toContain('ja entregou');
  });

  it('traz o criterio de pronto do plano, que ja e escrito para quem nao le codigo', () => {
    const pronto = row(buildAgentCard(meio, script.backend, roles)!, 'Pronto quando');

    expect(pronto?.value.length).toBeGreaterThan(10);
    expect(pronto?.value).not.toContain('src/');
  });

  it('detalhe tecnico existe, e fica so no detalhe', () => {
    const card = buildAgentCard(meio, script.backend, roles)!;

    expect(card.detail).toContain('office/backend');
    expect(card.detail).toContain('claude-sonnet-4-5');
    // Nada disso pode ter vazado para a frase principal de nenhuma linha.
    const frases = card.rows.flatMap((item) => [item.value, item.note ?? '']).join(' ');
    expect(frases).not.toContain('office/');
    expect(frases).not.toContain('claude-sonnet-4-5');
  });
});

describe('shortModel', () => {
  it('reduz o nome canonico a familia, que e o que distingue dois modelos', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(shortModel('claude-haiku-4-5')).toBe('haiku');
  });

  it('devolve o nome inteiro quando nao ha o que reduzir', () => {
    expect(shortModel('mock')).toBe('mock');
  });
});
