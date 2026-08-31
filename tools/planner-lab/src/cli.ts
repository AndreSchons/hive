#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  rosterSchema,
  newRunId,
  type RoleDefinition,
  type Roster,
} from '@office/protocol';
import { ClaudeAdapter, type AgentAdapter } from '@office/agents';
import {
  AgentPlanner,
  discoverGates,
  type AvailableGate,
  type PlanResult,
} from '@office/coordination';
import { checkPlan } from './checks';
import { TASKS, findTask, type ExampleTask } from './tasks';

/**
 * Roda **so** o gerente sobre as tasks de exemplo, sem executar nada.
 *
 * E o que torna afinar o prompt viavel: uma rodada aqui custa dez chamadas de
 * planejamento, contra dez execucoes inteiras com agentes mexendo em worktrees.
 * O gerente roda em modo somente-leitura, entao apontar isto para um projeto de
 * verdade nao muda um arquivo dele.
 */

const ROSTER: Roster = rosterSchema.parse([
  { id: 'gerente', title: 'Gerente', adapter: 'claude', model: 'opus', canDelegate: true,
    description: 'Decompoe a task, publica contratos, valida entregas e integra.' },
  { id: 'backend', title: 'Backend', adapter: 'claude', canDelegate: false,
    description: 'Dados, rotas, schemas e regras de negocio.' },
  { id: 'frontend', title: 'Interface e 3D', adapter: 'claude', canDelegate: false,
    description: 'Telas, componentes e o escritorio 3D.' },
  { id: 'revisao', title: 'Revisao', adapter: 'claude', canDelegate: false,
    description: 'Le o que os outros entregaram antes de integrar.' },
]);

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const withEquals = process.argv.find((arg) => arg.startsWith(prefix));
  if (withEquals !== undefined) return withEquals.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const USO = [
  'uso: office-plan-lab [--task <id>|all] [--project <pasta>] [--out <pasta>]',
  '',
  'tasks disponiveis:',
  ...TASKS.map((task) => `  ${task.id.padEnd(20)} ${task.probes}`),
  '',
  'o gerente roda em modo somente-leitura: ele le o projeto e nao muda nada.',
].join('\n');

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(USO);
    return;
  }

  const which = readFlag('task') ?? 'all';
  const projectPath = resolve(readFlag('project') ?? process.cwd());
  const outDir = readFlag('out');

  const chosen = which === 'all' ? TASKS : [findTask(which)].filter(isTask);
  if (chosen.length === 0) {
    console.error(`nao conheco a task "${which}".\n\n${USO}`);
    process.exitCode = 1;
    return;
  }

  const manager = ROSTER.find((role) => role.canDelegate);
  if (manager === undefined) throw new Error('o roster nao tem gerente');

  const adapter = adapterFor(manager);
  const probe = await adapter.probe();
  if (!probe.available) {
    console.error(`nao consigo rodar o gerente: ${probe.reason}`);
    process.exitCode = 1;
    return;
  }

  const gates = discoverGates(projectPath);
  console.log(`projeto: ${projectPath}`);
  console.log(`portoes encontrados: ${gates.map((gate) => gate.command).join(', ') || '(nenhum)'}`);
  console.log(`gerente: ${manager.title} via ${adapter.displayName} ${probe.version}\n`);

  if (outDir !== undefined) mkdirSync(resolve(outDir), { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let planned = 0;
  let failures = 0;
  let spent = 0;

  for (const task of chosen) {
    process.stdout.write(`── ${task.id} ${'─'.repeat(Math.max(0, 58 - task.id.length))}\n`);
    console.log(`   pedido: ${task.goal}`);
    console.log(`   testa:  ${task.probes}`);

    const started = Date.now();
    // O gasto vem do proprio log do gerente: `agent.usage` sai por modelo, e
    // planejar mistura mais de um. Somar aqui e o que torna "esta mudanca de
    // prompt ficou mais cara?" uma pergunta com resposta.
    let cost = 0;
    const planner = new AgentPlanner({
      adapter,
      role: manager,
      emit: (event) => {
        if (event.type === 'agent.usage') cost += event.payload.costUsd;
      },
    });
    const result = await planner.plan({
      runId: newRunId(),
      goal: task.goal,
      roster: ROSTER,
      project: { path: projectPath, baseBranch: 'HEAD', availableGates: gates },
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    spent += cost;

    report(task, result, gates, seconds, cost);
    if (result.status === 'planned') planned += 1;
    if (task.expectStatus !== undefined && task.expectStatus !== result.status) failures += 1;
    if (outDir !== undefined) save(resolve(outDir), stamp, task, result);
  }

  console.log(`\n${planned} de ${chosen.length} viraram plano.`);
  // O numero que diz se afinar o prompt saiu caro. Zero quando a CLI usada nao
  // reporta consumo -- ausente e diferente de barato.
  console.log(
    spent > 0
      ? `custo da rodada: ${money(spent)} (${money(spent / chosen.length)} por task)`
      : 'custo da rodada: esta CLI nao reporta consumo.',
  );
  const cobradas = chosen.filter((task) => task.expectStatus !== undefined);
  if (cobradas.length > 0) {
    console.log(
      failures === 0
        ? `${cobradas.length} tasks com desfecho esperado: todas bateram.`
        : `${failures} de ${cobradas.length} tasks com desfecho esperado REGREDIRAM.`,
    );
    if (failures > 0) process.exitCode = 1;
  }
  if (outDir !== undefined) console.log(`planos gravados em ${resolve(outDir)}`);
}

function report(
  task: ExampleTask,
  result: PlanResult,
  gates: readonly AvailableGate[],
  seconds: string,
  cost: number,
): void {
  const custo = cost > 0 ? `, ${money(cost)}` : '';
  if (result.status === 'needs_input') {
    console.log(`   → perguntou (${seconds}s${custo}): ${result.question}`);
    console.log(`   ${verdict(task, result.status)}`);
    console.log(`   esperado: ${task.expect}\n`);
    return;
  }

  const report = checkPlan({ plan: result.plan, roster: ROSTER, gates: [...gates] });
  console.log(
    `   → plano (${seconds}s${custo}): ${report.subtasks} subtasks, profundidade ${report.depth}, ` +
      `${report.firstWave} na primeira leva, ${report.contracts} contratos`,
  );

  for (const [index, subtask] of result.plan.subtasks.entries()) {
    const deps = subtask.dependsOn.length > 0 ? ` ← ${subtask.dependsOn.join(', ')}` : '';
    const paths = subtask.allowedPaths.length > 0 ? `  [${subtask.allowedPaths.join(' ')}]` : '';
    console.log(`      ${index + 1}. ${subtask.id} (${subtask.role})${deps}${paths}`);
  }

  for (const finding of report.findings) {
    console.log(`   ${finding.level === 'erro' ? '✗' : '!'} ${finding.message}`);
  }
  console.log(`   ${verdict(task, result.status)}`);
  console.log(`   esperado: ${task.expect}\n`);
}

/**
 * O veredito das tasks cujo desfecho certo e binario. Sem isto, uma regressao
 * como "passou a planejar o que devia perguntar" so aparece se alguem ler a
 * saida inteira com atencao -- e ai ela ja passou.
 */
function verdict(task: ExampleTask, got: 'planned' | 'needs_input'): string {
  if (task.expectStatus === undefined) return 'veredito: so lendo (os dois desfechos sao aceitaveis)';
  if (task.expectStatus === got) return `✓ era para ${label(got)}`;
  return `✗ REGRESSAO: era para ${label(task.expectStatus)} e ${label(got)}`;
}

const label = (status: 'planned' | 'needs_input'): string =>
  status === 'planned' ? 'planejar' : 'perguntar';

/** Grava para poder comparar duas versoes do prompt com `diff`. */
function save(outDir: string, stamp: string, task: ExampleTask, result: PlanResult): void {
  const body =
    result.status === 'planned'
      ? { status: 'planned', subtasks: result.plan.subtasks, contracts: result.plan.contracts }
      : { status: 'needs_input', question: result.question, context: result.context };

  writeFileSync(
    join(outDir, `${task.id}.${stamp}.json`),
    `${JSON.stringify({ goal: task.goal, ...body }, null, 2)}\n`,
  );
}

function adapterFor(_role: RoleDefinition): AgentAdapter {
  return new ClaudeAdapter();
}

const isTask = (task: ExampleTask | undefined): task is ExampleTask => task !== undefined;

/** Quatro casas: um planejamento custa fracao de centavo e duas mostrariam zero. */
const money = (value: number): string => `US$ ${value.toFixed(4)}`;

main().catch((error: unknown) => {
  console.error('[planner-lab]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
