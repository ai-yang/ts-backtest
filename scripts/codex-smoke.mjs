// Ephemeral real-client acceptance. No changes to the user's Codex configuration.
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const evidence = resolve(root, 'docs/evidence');
const metadata = JSON.parse(await readFile(resolve(root, 'examples/metadata.json'), 'utf8'));
const { spec } = JSON.parse(await readFile(resolve(root, 'examples/basic.json'), 'utf8'));
const prompt = `This is an authorized local integration test of the backtest MCP server. Use only the backtest MCP tools; do not run shell commands, modify source files, fetch market data, or use other services. The data is synthetic.
Execute these steps through actual tool calls in this same connection:
1. backtest_capabilities summary.
2. backtest_prepare_data with path "examples/prices.csv", format "csv", and metadata ${JSON.stringify(metadata)}. Poll backtest_job until it succeeds; keep datasetId.
3. backtest_validate with that datasetId and this explicit spec: ${JSON.stringify(spec)}.
4. backtest_run with the returned planId. Poll backtest_job until terminal; keep runId.
5. backtest_result summary. Assert finalEquity is exactly "1100.00", netProfit "100.00", and fillCount 2.
6. Query fills with limit 1, then the returned cursor to get the second fill. Assert buy 100 at 10 then sell 100 at 11, with no duplicate fill IDs.
7. backtest_explain for the first fillId; poll its job until terminal. Verify the explanation contains actual execution and fee evidence.
Return a compact JSON object with passed, datasetId, planId, runId, finalEquity, fillIds, explanationVerified, and any failed assertions. If any tool fails, report the actual failure; never invent tool output.`;
await mkdir(evidence, { recursive: true });
const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never',
  '-C', root, '-s', 'workspace-write', '-c', 'approval_policy="never"',
  '-c', 'mcp_servers.backtest.command="node"',
  '-c', `mcp_servers.backtest.args=${JSON.stringify([resolve(root, 'dist/src/adapters/mcp.js'), '--workspace', root, '--store', resolve(root, '.backtest/codex-smoke'), '--workers', '2'])}`,
  '-c', 'mcp_servers.backtest.startup_timeout_sec=30', '-c', 'mcp_servers.backtest.tool_timeout_sec=120',
  '-o', resolve(evidence, 'codex-smoke-final.json'), prompt];
const child = spawn('codex', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240_000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timeout);
await writeFile(resolve(evidence, 'codex-smoke.jsonl'), stdout);
await writeFile(resolve(evidence, 'codex-smoke-stderr.log'), stderr);
await writeFile(resolve(evidence, 'codex-smoke-status.json'), JSON.stringify({ exitCode: code, timedOut, at: new Date().toISOString(), command: 'node scripts/codex-smoke.mjs', configurationScope: 'ephemeral --ignore-user-config -c; user config unchanged' }, null, 2));
process.exitCode = typeof code === 'number' ? code : 1;
