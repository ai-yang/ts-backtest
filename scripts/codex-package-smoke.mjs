// Real Codex client, production bundle. Configuration is ephemeral.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { input, spec, instrument, sessions, closeAt } from '../dist/test/helpers.js';

const root = resolve(import.meta.dirname, '..');
const evidence = resolve(root, 'docs/evidence');
const server = resolve(root, 'dist/package/ts-backtest/mcp.cjs');
const fixture = resolve(root, '.backtest/codex-package-input');
await mkdir(evidence, { recursive: true });
await mkdir(fixture, { recursive: true });
const data = input(['10', '10', '12', '13', '14', '15', '16', '17']);
const original = [...data.bars];
for (const [symbol, delta] of [['BBB', 1], ['CCC', 2]]) {
  data.metadata.instruments.push(instrument(symbol));
  data.bars.push(...original.map(b => ({ ...b, symbol, ...Object.fromEntries(['open', 'high', 'low', 'close'].map(field => [field, String(Number(b[field]) + delta)])) })));
}
data.features = data.metadata.instruments.map((i, index) => ({ symbol: i.symbol, name: 'score', value: index + 1, availableAt: closeAt(sessions[0]) }));
const specification = spec({ end: closeAt(sessions[7]) + 1, strategy: { kind: 'rules', nodes: {}, rules: [{ when: { value: true }, action: { type: 'target_quantity', value: 2 } }] } });
const sweep = { space: { '/strategy/rules/0/action/value': [1, 2] }, objective: { metric: 'netProfit', direction: 'maximize' }, concurrency: 1, seed: 42 };
const walk = { ...sweep, trainSessions: 2, testSessions: 2, mode: 'rolling', warmup: 'all_prior', positionPolicy: 'carry', pendingOrderPolicy: 'carry' };
const factors = { feature: 'score', from: specification.start, to: specification.end, horizonBars: 1, groups: 2, minSamples: 3 };
await writeFile(resolve(fixture, 'bars.json'), JSON.stringify(data));
const prompt = `Authorized integration test of a packaged local backtest MCP server with synthetic data. Use only backtest MCP tools. Do not run shell commands or read/write files through other tools. Never invent tool results. Complete ALL steps in the same connection. Every submitted job must be polled with backtest_job until terminal. If a tool error occurs, report it accurately.
1. backtest_capabilities summary.
2. backtest_prepare_data path ".backtest/codex-package-input/bars.json", format "json"; poll and keep datasetId.
3. backtest_validate with datasetId, background:true and spec ${JSON.stringify(specification)}; poll its validation job and keep planId from the completed result.
4. backtest_run with planId; poll and keep runId.
5. backtest_result table "summary": verify finalEquity "1042.00", netProfit "42.00", fillCount 3. All are exact known synthetic golden values.
6. backtest_result table "fills", limit 1; keep first fillId and cursor. Call again with that cursor and limit 1. Verify distinct IDs.
7. backtest_explain with runId and first fillId; poll job and check selected fill plus linked ledger evidence.
8. backtest_report with runId; keep the report file handle and sha256. Do not read the HTML into chat.
9. backtest_sweep with planId and request ${JSON.stringify(sweep)}; poll and keep studyId. backtest_study table "candidates", limit 1, then next page via returned cursor. Verify two distinct candidates and exact net profits 21.00 and 42.00 (sorting may differ).
10. backtest_walk_forward with planId and request ${JSON.stringify(walk)}; poll and keep studyId and continuous runId. backtest_study table "windows": verify 3 windows. backtest_result on its continuous runId table "events" filter {"type":"initial"}: verify exactly one initial event, proving there is one ledger across OOS windows.
11. backtest_factors with datasetId and request ${JSON.stringify(factors)}; poll and keep studyId. backtest_study table "periods" limit 2: verify two returned rows with actual diagnostics.
Return a compact JSON object with passed, runId, finalEquity, reportSha256, sweepStudyId, walkForwardStudyId, factorStudyId, toolNamesUsed and failedAssertions. The verifier independently checks actual tool outputs.`;
const prefix = 'codex-package-smoke';
const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never', '-C', root, '-s', 'workspace-write', '-c', 'approval_policy="never"',
  '-c', 'mcp_servers.backtest.command="node"', '-c', `mcp_servers.backtest.args=${JSON.stringify([server, '--workspace', root, '--store', resolve(root, '.backtest/codex-package-smoke'), '--workers', '2'])}`,
  '-c', 'mcp_servers.backtest.startup_timeout_sec=30', '-c', 'mcp_servers.backtest.tool_timeout_sec=120', '-o', resolve(evidence, `${prefix}-final.json`), prompt];
const child = spawn('codex', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false;
child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 420_000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timeout);
await writeFile(resolve(evidence, `${prefix}.jsonl`), stdout);
await writeFile(resolve(evidence, `${prefix}-stderr.log`), stderr);
await writeFile(resolve(evidence, `${prefix}-status.json`), JSON.stringify({ exitCode: code, timedOut, at: new Date().toISOString(), server, serverSha256: createHash('sha256').update(await readFile(server)).digest('hex'), fixtureSha256: createHash('sha256').update(await readFile(resolve(fixture, 'bars.json'))).digest('hex'), command: 'node scripts/codex-package-smoke.mjs', configurationScope: 'ephemeral --ignore-user-config -c; user config unchanged' }, null, 2));
process.exitCode = typeof code === 'number' ? code : 1;
