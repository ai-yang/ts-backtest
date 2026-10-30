import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';

// Synthetic, local fixture. No strategy source code is evaluated by the engine.
const here = dirname(fileURLToPath(import.meta.url));
const { BacktestService } = await import(existsSync(join(here, '../service.cjs')) ? '../service.cjs' : '../dist/src/runtime/manager.js');
const json = async name => JSON.parse(await readFile(join(here, name), 'utf8'));
const base = (await json('basic.json')).spec;
base.strategy = { kind: 'rules', nodes: {}, rules: [{ when: { value: true }, action: { type: 'target_quantity', value: 1 } }] };
const storeDir = process.argv[2] ?? await mkdtemp(join(tmpdir(), 'ts-backtest-research-example-'));
const service = new BacktestService({ workspace: here, storeDir });
async function complete(job) {
  for (;;) {
    const status = await service.job(job.id);
    if (status.state === 'succeeded') return status.result;
    if (['failed', 'canceled', 'interrupted'].includes(status.state)) throw new Error(JSON.stringify(status.error ?? status));
    await delay(10);
  }
}
await service.init();
try {
  const prepared = await complete(await service.prepare({ path: 'prices.csv', format: 'csv', metadata: await json('metadata.json'), features: [{ symbol: 'AAA', name: 'prediction', availableAt: base.start, value: 1 }] }));
  const plan = await service.validate(prepared.datasetId, base);
  const sweep = await complete(await service.sweep(plan.planId, await json('research-sweep.json')));
  const walkForward = await complete(await service.walkForward(plan.planId, await json('research-walk-forward.json')));
  const factors = await complete(await service.factors(prepared.datasetId, await json('research-factors.json')));
  for (const result of [sweep, walkForward, factors]) {
    const summary = await service.study(result.studyId, { table: 'summary' });
    process.stdout.write(JSON.stringify({ ...result, summary: summary.rows[0] }) + '\n');
  }
  process.stdout.write(JSON.stringify({ storeDir }) + '\n');
} finally { await service.close(); }
