import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const path=resolve(root,'docs/evidence/benchmark.json');
const report=JSON.parse(await readFile(path,'utf8'));
const final=JSON.parse(await readFile(resolve(root,'docs/evidence/benchmark-final-hot.json'),'utf8'));
if (!report.complete || !final.complete) throw new Error('Both full and final-hot benchmark reports must be complete');
const initial=report.cases.some(value=>!value.buildFiles)?JSON.parse(await readFile(resolve(root,'benchmark-output/initial-build.json'),'utf8')):null;
for(const value of report.cases) if(!value.buildFiles) { value.buildFiles=initial.files; value.buildCaptureNote='These module hashes were captured while the first two long-running children were active. Their module file mtimes precede benchmark creation, and the captures preceded subsequent rebuilds.'; }
report.finalVerification={file:'benchmark-final-hot.json',complete:final.complete,primarySingleInstrumentHotCases:final.cases.filter(c=>c.id.startsWith('final_minute')).map(c=>({id:c.id,rowCount:c.identity.rowCount,p50Ms:c.stages.hotRun.p50Ms,p95Ms:c.stages.hotRun.p95Ms,fillCount:c.result.metrics.fillCount,buildFiles:c.buildFiles})),millionBarsUnderTwoSeconds:final.cases.find(c=>c.id==='final_minute_1m').stages.hotRun.p50Ms<2000};
report.coldStartupSupersededBy='benchmark-final-hot.json coldStartup was repeated after the final production code bundle was built';
await writeFile(path,JSON.stringify(report,null,2));
const fixed=(n,d=2)=>Number(n).toFixed(d), mib=n=>fixed(n/1048576), seconds=n=>fixed(n/1000,3);
const byId=id=>report.cases.find(c=>c.id===id);
const stageTable=cases=>cases.map(c=>`| ${c.id} | ${c.identity.rowCount.toLocaleString('en-US')} / ${c.identity.symbols} | ${c.result.metrics.fillCount.toLocaleString('en-US')} | ${seconds(c.stages.hotRun.p50Ms)} / ${seconds(c.stages.hotRun.p95Ms)} | ${mib(c.peakRssBytes)} |`).join('\n');
const first=byId('minute_240k'),million=byId('minute_1m');
const stages=['csvReadValidateNormalize','cacheEncode','cacheWrite','cacheRead','cacheDecodeValidate','resultWrite','csvToResultEndToEnd'];
const labels={csvReadValidateNormalize:'CSV 读取 + 字段校验 + 规范化',cacheEncode:'列式缓存编码',cacheWrite:'缓存写文件',cacheRead:'缓存读文件',cacheDecodeValidate:'缓存解码 + 校验和 + 重新规范化验证',resultWrite:'summary 结果写入及原子发布',csvToResultEndToEnd:'CSV → 回测 → summary 产物（端到端）'};
const io=stages.map(name=>`| ${labels[name]} | ${seconds(first.stages[name].p50Ms)} / ${seconds(first.stages[name].p95Ms)} | ${seconds(million.stages[name].p50Ms)} / ${seconds(million.stages[name].p95Ms)} |`).join('\n');
const sweeps=report.cases.filter(c=>c.id.includes('workers')).map(c=>`| ${c.research.candidateCount} × ${c.identity.rowCount.toLocaleString('en-US')} | ${c.research.workers} | ${c.research.totalCandidateBars.toLocaleString('en-US')} | ${seconds(c.stages.sweep.p50Ms)} / ${seconds(c.stages.sweep.p95Ms)} | ${mib(c.peakRssBytes)} |`).join('\n');
const cold=final.coldStartup.map(c=>`| ${c.nodeVersion??(c.runtime.includes('node22')?final.cases.find(value=>value.id==='node22_minute_240k').runtime:final.environment.node)} | ${c.kind==='bundle'?'生产 core.cjs':'编译后模块目录'} | ${fixed(c.p50Ms)} / ${fixed(c.p95Ms)} |`).join('\n');
const wf=byId('walk_forward_3_windows');
const gc=first.stages.hotRun.samples;
const peakMemory=mib(million.peakRssBytes);
const finalMillion=final.cases.find(c=>c.id==='final_minute_1m');
const markdown=`# 实测性能与边界

历史测量的名称、路径和代码哈希以原始 JSON 为准；项目更名后的正确性与分发包验证不代表重新测量了这些性能数据。

冻结代码在本机单证券 **1,000,000 根分钟 Bar、9,998 次成交**的热回测中，5 次样本的 p50 为 **${seconds(finalMillion.stages.hotRun.p50Ms)} 秒**，p95 为 **${seconds(finalMillion.stages.hotRun.p95Ms)} 秒**。没有达到原设计的“百万 Bar 小于 2 秒”目标。24 万根、2,398 次成交的 p50 为 **${seconds(final.cases[0].stages.hotRun.p50Ms)} 秒**。这些是实测结果，不从小样本外推。

原始数据与逐样本数据见 [完整场景](evidence/benchmark.json)、[最终代码复测](evidence/benchmark-final-hot.json)。完整测试包含 14 个独立子进程场景；冻结修复后额外复测热引擎、异常数据及 Node 22，并重测进程冷启动。JSON 逐场景记录实际构建 SHA、数据哈希、样本、指标和资源信息。最初两个长 IO 场景的模块 SHA 来自修改前的独立快照；其 IO 数据未冒充最终修复版热引擎测量。

## 环境与口径

- CPU：${report.environment.cpu}；${report.environment.logicalCpus} 个逻辑 CPU，内存 ${fixed(report.environment.totalMemoryBytes/1073741824)} GiB；${report.environment.platform} ${report.environment.arch}，内核 ${report.environment.osRelease}。
- 主基准 Node ${report.environment.node}；Node 22.23.4 另测核心、冷启动与生产包。Windows、macOS、Bun 没有实测。
- 每项正常计时至少 5 样本，百分位采用 nearest-rank；5 样本的 p95 等于最大值，不是稳定的尾部延迟估计。机器与开发任务共享，没有 CPU 隔离、频率锁定或清空操作系统文件缓存。
- 热运行前执行 1 次不计入统计的 JIT 预热。正常计时不启用 CPU/Heap profiler，\`measurePhases\` 为 false，\`indicatorMs/engineMs\` 的 null 表示未测量，不能当作 0。
- 普通 IO 使用操作系统缓存，不执行 fsync。端到端从已有 CSV 的导入开始，到结果原子发布结束；不含合成数据生成、文件首次生成或 Node 启动。数据规范化、策略校验和核心模拟均真实执行。
- 数据是确定性的三角价格序列，显式标记为 **每天都是合成交易日**，包含周末；不冒充真实市场交易日历。日线组合使用足以覆盖组合的显式初始资金。全部成本、滑点、T+0 与手数规则见 \`scripts/benchmark-fixture.ts\`。
- 大型 SDK 导入测试将 \`maxFileBytes\` 显式设为 512 MiB、行预算 200 万，缓存校验预算 512 MiB。它们不是默认 64 MiB 导入预算下的 MCP 测试；实际部署仍须配置合适的资源预算。

## 最终代码热回测

| 场景 | 总 Bar / 证券数 | 成交次数 | p50 / p95（秒） | 子进程峰值 RSS（MiB） |
| --- | ---: | ---: | ---: | ---: |
${stageTable(final.cases)}

这里的峰值 RSS 包含该子进程的数据准备和规范化，不能解读为纯热循环的额外内存；每次热运行结束时的 RSS、heap、ArrayBuffer 和 GC 数据也保留在 JSON。分钟回撤覆盖为 \`unverified\`：这不影响基准完成交易计算，但风险指标仅基于已观察估值，不能宣称完整报价覆盖。

## 冷数据与端到端成本

下表属于第一次完整场景运行，正常计时 5 样本。CSV、缓存和校验实现与最终复测一致；最终热引擎数字以上一节为准。

| 阶段 | 240,000 Bar p50 / p95（秒） | 1,000,000 Bar p50 / p95（秒） |
| --- | ---: | ---: |
${io}

百万 Bar 的 CSV 为 ${million.identity.csvBytes.toLocaleString('en-US')} bytes，缓存为 ${million.identity.cacheBytes.toLocaleString('en-US')} bytes；整个导入/编解码/重复回测子进程峰值为 **${peakMemory} MiB RSS**。缓存当前强调可移植和完整性校验，冷解码仍会重建并重新验证数据，不能宣传数量级的冷加载加速。参数扫描的候选之间共享并复用已验证的列式数据；普通 prepare/validate/run/explain 作业仍各自进行导入或解码及校验，SDK 热运行数值不能代替普通 MCP 请求时延。尚未实现普通作业的数据 LRU 缓存。引擎不是 out-of-core 系统。

\`resultWrite\` 的主场景使用 summary，小产物写入时间不代表 fullTrace。部分成交场景使用 fullTrace：24,000 Bar、${byId('partial_high_turnover_24k').result.metrics.fillCount.toLocaleString('en-US')} 次成交，产物写入 p50 为 ${seconds(byId('partial_high_turnover_24k').stages.resultWrite.p50Ms)} 秒，完整 CSV→结果为 ${seconds(byId('partial_high_turnover_24k').stages.csvToResultEndToEnd.p50Ms)} 秒。

## 组合、无交易和异常数据

| 场景 | 总 Bar / 证券数 | 成交次数 | p50 / p95（秒） | 子进程峰值 RSS（MiB） |
| --- | ---: | ---: | ---: | ---: |
${stageTable(report.cases.filter(c=>['daily_100_symbols_100k','daily_1000_symbols_1m','partial_high_turnover_24k','no_trade_240k','missing_suspension_actions_10k'].includes(c.id)))}

边界场景实际删除 ${byId('missing_suspension_actions_10k').identity.edgeCounts.missingRows} 行，含 ${byId('missing_suspension_actions_10k').identity.edgeCounts.suspendedRows} 行停牌数据，以及拆股、分红各一次。最终复测会将持仓缺报价的回撤覆盖标为 incomplete，保留观测回撤而不伪造缺失行情。

## 独立参数扫描与 Walk-forward

| 参数组 × 每组 Bar | Worker 数 | 实际参数组 × Bar 总量 | p50 / p95（秒） | 子进程峰值 RSS（MiB） |
| --- | ---: | ---: | ---: | ---: |
${sweeps}

上述每项完整执行全部候选；0 个失败候选。单 Worker 与 4 Worker 的全部候选结果摘要、种子和执行指纹一致，另外有 8×2,400 的小金标并发对照。时间包含共享数据准备、Worker 启动、调度、模拟和结果汇总，不只是计算内核。GC 观察器只覆盖主 isolate；Worker GC 没有被错误记成“总 GC 为 0”。

连续 Walk-forward 使用 2,400 根分钟 Bar、10 个观测交易日，4 日训练 / 2 日测试，3 个连续样本外窗口，每窗 3 个候选、2 Worker。p50 / p95 为 **${seconds(wf.stages.walkForward.p50Ms)} / ${seconds(wf.stages.walkForward.p95Ms)} 秒**。保留持仓和未完成订单，样本外使用同一个账户；相邻窗口边界及训练先于测试已断言。预算口径为 ${wf.research.trainingBudgetBars.toLocaleString('en-US')} 训练候选×输入行 + ${wf.research.continuousBudgetBars.toLocaleString('en-US')} 行连续运行，并未把多个窗口收益简单拼接。

## 进程冷启动、GC 与分配

| Node | 入口 | 进程创建 + import p50 / p95（毫秒） |
| --- | --- | ---: |
${cold}

冷启动指新 Node 进程，不是磁盘冷缓存。生产包的 Node 22/24 外部解压、空 PATH/NODE_PATH、禁网络、SDK/CLI/MCP/研究 Worker/可选格式烟测见 \`dist/package/smoke-report.json\`；体积见 \`dist/package/size-report.json\`，压缩大小与解压大小分开。

240k 首次完整场景热运行的 GC 事件数为 ${gc.map(v=>v.gcCount).join('/')}，GC duration 为 ${gc.map(v=>fixed(v.gcMs)).join('/')} ms。通过 PerformanceObserver 收集，并在计时区间之后让事件循环投递，避免同步代码结束时错误报告零 GC；这些 duration 不是精确的所有线程停顿总量。

独立 HeapProfiler 采样使用 32 KiB 采样间隔，包含已回收对象，估算分配 **${fixed(first.allocationProfile.estimatedAllocatedBytes/1073741824,3)} GiB**、${first.allocationProfile.sampleCount.toLocaleString('en-US')} 个样本。它是带采样开销的统计估算，不是精确总分配；该诊断运行耗时 ${seconds(first.allocationProfile.profiledRunMs)} 秒，未并入正常 p50/p95。heap delta 仅报告保留堆变化，可能为负，不替代分配总量。

同一 240k 输入开启逐阶段计时的单独诊断运行耗时 ${seconds(first.instrumentedPhaseTiming.wallMs)} 秒，对比正常热运行 p50 ${seconds(first.stages.hotRun.p50Ms)} 秒，说明频繁 clock 调用会明显增加开销。早期 \`benchmark-output/pre-optimization-240000.json\` 的 3.943 秒也同时开启 CPU profiler 和阶段计时，不能直接作为与正常样本严格可比的“加速倍数”。

## 复现

\`\`\`bash
npm ci
npm ci --prefix optional-formats
npm run package
npm run benchmark:quick
npm run benchmark
node scripts/benchmark.mjs --final-hot --samples=5
node scripts/render-benchmark.mjs
npm run test:package
\`\`\`

脚本将大型 CSV/缓存放入系统临时目录，每个场景完成后删除，只保留小 JSON 报告；全部场景串行运行。若没有本地 Node 22 二进制，脚本会明确只运行当前 Node，不冒充跨版本验证。原始报告记录此轮确实执行的版本与场景。Node 性能/内存口径参见 [PerformanceObserver](https://nodejs.org/api/perf_hooks.html#class-performanceobserver)、[resourceUsage](https://nodejs.org/api/process.html#processresourceusage) 和 [HeapProfiler 采样协议](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/)。
`;
await writeFile(resolve(root,'docs/PERFORMANCE.md'),markdown);
console.log('Wrote docs/PERFORMANCE.md and annotated benchmark build provenance');
