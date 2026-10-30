import assert from 'node:assert/strict';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, availableParallelism, release as osRelease, loadavg } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);
const nearest = (values, q) => [...values].sort((a,b)=>a-b)[Math.max(0, Math.ceil(values.length*q)-1)];
const aggregate = samples => ({ count: samples.length, p50Ms: nearest(samples.map(v=>v.ms),.5), p95Ms: nearest(samples.map(v=>v.ms),.95), minMs: Math.min(...samples.map(v=>v.ms)), maxMs: Math.max(...samples.map(v=>v.ms)), samples });
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

async function runChild(configuration) {
  const loadedAt = performance.now();
  const [{ syntheticInput, syntheticSpec }, { normalizeDataset }, { importDataset }, { encodeDataset, decodeDataset }, { runBacktest, ENGINE_VERSION }, { persistResult }, { runSweep }, { runWalkForward }] = await Promise.all([
    import('../dist/scripts/benchmark-fixture.js'), import('../dist/src/data/normalize.js'), import('../dist/src/data/import.js'), import('../dist/src/data/serialize.js'), import('../dist/src/engine/run.js'), import('../dist/src/runtime/results.js'), import('../dist/src/research/sweep.js'), import('../dist/src/research/walk-forward.js'),
  ]);
  const moduleLoadMs = performance.now()-loadedAt;
  const buildFiles = {};
  for (const path of ['dist/src/engine/run.js', 'dist/src/accounting/ledger.js', 'dist/src/analytics/metrics.js']) buildFiles[path] = { sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex'), modifiedAt: (await stat(resolve(root, path))).mtime.toISOString() };
  const temp = await mkdtemp(join(tmpdir(), 'backtest-benchmark-'));
  const gc = []; const observer = new PerformanceObserver(list => gc.push(...list.getEntries())); observer.observe({ entryTypes:['gc'] });
  const stages = {};
  async function measure(name, operation) {
    await settle(); const memoryBefore = process.memoryUsage(), cpuBefore=process.cpuUsage(), from=performance.now();
    const result = await operation(); const until=performance.now(), cpu=process.cpuUsage(cpuBefore), memoryAfter=process.memoryUsage(); await settle();
    const events=gc.filter(entry=>entry.startTime>=from&&entry.startTime<until);
    (stages[name]??=[]).push({ms:until-from, cpuMs:(cpu.user+cpu.system)/1000, heapUsedBefore:memoryBefore.heapUsed, heapUsedAfter:memoryAfter.heapUsed, heapDeltaBytes:memoryAfter.heapUsed-memoryBefore.heapUsed, externalAfter:memoryAfter.external, arrayBuffersAfter:memoryAfter.arrayBuffers, rssAfter:memoryAfter.rss, gcCount:events.length, gcMs:events.reduce((n,e)=>n+e.duration,0)});
    return result;
  }
  try {
    const begin=performance.now(); const raw=syntheticInput(configuration.bars, configuration.symbols??1, configuration.frequency??'minute');
    const last = new Map(); for(const bar of raw.bars) last.set(bar.symbol,bar);
    const spec=syntheticSpec({...raw,bars:[raw.bars[0],...last.values()]},configuration.partial??false);
    if((configuration.symbols??1)>1) spec.account.initialCash='1000000000';
    if(configuration.noTrade) spec.strategy.rules.forEach(rule=>{rule.when={value:false};});
    if(configuration.fullTrace) spec.output.level='fullTrace';
    const edgeCounts={missingRows:0,suspendedRows:0,corporateActions:0};
    if(configuration.edge){
      const missing=raw.bars.filter((bar,i)=>bar.symbol==='S0003'&&i%97===0);edgeCounts.missingRows=missing.length;const remove=new Set(missing);raw.bars=raw.bars.filter(bar=>!remove.has(bar));
      const splitAt=Date.parse(raw.metadata.sessions[1000]+'T01:30:00Z');
      for(const bar of raw.bars){if(bar.symbol==='S0000'&&bar.openTime>=splitAt){for(const key of ['open','high','low','close'])bar[key]=(Number(bar[key])/2).toFixed(2);}if(bar.symbol==='S0002'&&bar.session>=raw.metadata.sessions[500]&&bar.session<=raw.metadata.sessions[509]){bar.tradable=false;bar.volume=0;bar.amount='0';edgeCounts.suspendedRows++;}}
      raw.actions=[{type:'split',symbol:'S0000',at:splitAt,ratio:'2'},{type:'dividend',symbol:'S0001',at:splitAt,amountPerShare:'0.01',payAt:Date.parse(raw.metadata.sessions[1010]+'T01:30:00Z')}];edgeCounts.corporateActions=raw.actions.length;
    }
    const metadata=structuredClone(raw.metadata), metadataEvents={features:raw.features,membership:raw.membership,actions:raw.actions};
    const generationMs=performance.now()-begin;
    let dataset; const initialNormalizeAt=performance.now(); dataset=normalizeDataset(raw); const initialNormalizeMs=performance.now()-initialNormalizeAt;
    const identity={datasetHash:dataset.hash,rowCount:dataset.rowCount,symbols:dataset.series.size,frequency:metadata.frequency,calendar:'synthetic-every-date-v1; every supplied date is a synthetic session, including weekends',start:spec.start,end:spec.end,output:spec.output.level,engineVersion:ENGINE_VERSION,edgeCounts};
    const source=join(temp,'input.csv'),cache=join(temp,'cache.json'),store=join(temp,'store');
    const csvFields=['symbol','openTime','closeTime','session','open','high','low','close','volume','amount','tradable'];
    if(configuration.mode==='pipeline'){
      const stream=createWriteStream(source);stream.write(csvFields.join(',')+'\n');let chunk='';
      for(const bar of raw.bars){chunk+=csvFields.map(field=>String(bar[field])).join(',')+'\n';if(chunk.length>64*1024){if(!stream.write(chunk))await once(stream,'drain');chunk='';}}
      stream.end(chunk);await once(stream,'finish');
    }
    raw.bars=[]; if(global.gc)global.gc();await settle();
    let gold, lastResult, research, allocationProfile, instrumentedPhaseTiming;
    if(configuration.mode==='sweep'||configuration.mode==='gold'){
      const parameters=Array.from({length:configuration.candidates},(_,i)=>i+100);
      const request={space:{'/strategy/rules/0/action/value':parameters},objective:{metric:'finalEquity',direction:'maximize'},seed:42,concurrency:configuration.workers??1,maxCandidates:configuration.candidates,maxTotalBars:dataset.rowCount*configuration.candidates,maxRuntimeMs:600000,workerMemoryMb:512};
      for(let i=0;i<configuration.samples;i++){
        research=await measure('sweep',()=>runSweep(dataset,spec,request));assert.equal(research.candidateCount,configuration.candidates);assert.equal(research.candidates.filter(c=>c.status==='succeeded').length,configuration.candidates);
        const compact={fingerprint:research.fingerprint,candidates:research.candidates};if(gold)assert.deepEqual(compact,gold);else gold=compact;
      }
      if(configuration.mode==='gold'){
        const parallel=await runSweep(dataset,spec,{...request,concurrency:4});assert.deepEqual(parallel.candidates,research.candidates);assert.equal(parallel.fingerprint,research.fingerprint);
        research={...research,goldParallelWorkers:4,goldEquivalent:true};
      }
    }else if(configuration.mode==='walk_forward'){
      for(let i=0;i<configuration.samples;i++){
        research=await measure('walkForward',()=>runWalkForward(dataset,spec,{space:{'/strategy/nodes/fast/period':[5,10,20]},objective:{metric:'finalEquity',direction:'maximize'},concurrency:2,maxCandidates:3,maxTotalBars:dataset.rowCount*100,maxRuntimeMs:120000,trainSessions:4,testSessions:2,mode:'rolling',warmup:'all_prior',positionPolicy:'carry',pendingOrderPolicy:'carry'}));
        assert.ok(research.windows.length>=2);for(let n=1;n<research.windows.length;n++)assert.equal(research.windows[n-1].testEnd,research.windows[n].testStart);
        const compact={fingerprint:research.fingerprint,metrics:research.continuous.metrics};if(gold)assert.deepEqual(compact,gold);else gold=compact;
      }
    }else{
      // One unmeasured JIT warm-up before repeated hot-engine samples.
      lastResult=runBacktest(dataset,spec);gold=lastResult.metrics;
      for(let i=0;i<configuration.samples;i++){
        lastResult=await measure('hotRun',()=>runBacktest(dataset,spec));assert.deepEqual(lastResult.metrics,gold);assert.equal(lastResult.timing.indicatorMs,null);assert.equal(lastResult.timing.engineMs,null);
      }
      if(configuration.expectedFillCount!==undefined)assert.equal(lastResult.metrics.fillCount,configuration.expectedFillCount);
      if(configuration.mode==='pipeline'){
        let encoded,text;
        for(let i=0;i<configuration.samples;i++){
          const imported=await measure('csvReadValidateNormalize',()=>importDataset({path:source,format:'csv',metadata,...metadataEvents,maxFileBytes:512*1024*1024,maxRows:2000000}));assert.equal(imported.hash,dataset.hash);
          encoded=await measure('cacheEncode',()=>encodeDataset(dataset));
          await measure('cacheWrite',()=>writeFile(cache,encoded));
          text=await measure('cacheRead',()=>readFile(cache,'utf8'));
          const decoded=await measure('cacheDecodeValidate',()=>decodeDataset(text,{maxBytes:512*1024*1024,maxRows:2000000}));assert.equal(decoded.hash,dataset.hash);
          const runId=`run_benchmark_write_${i}`;await measure('resultWrite',()=>persistResult(store,runId,lastResult,{maxBytes:256*1024*1024}));await rm(join(store,'runs',runId),{recursive:true,force:true});
          const endId=`run_benchmark_e2e_${i}`;
          const e2e=await measure('csvToResultEndToEnd',async()=>{const value=await importDataset({path:source,format:'csv',metadata,...metadataEvents,maxFileBytes:512*1024*1024,maxRows:2000000});const result=runBacktest(value,spec);await persistResult(store,endId,result,{maxBytes:256*1024*1024});return result;});assert.deepEqual(e2e.metrics,gold);await rm(join(store,'runs',endId),{recursive:true,force:true});
        }
        identity.csvBytes=(await stat(source)).size;identity.cacheBytes=(await stat(cache)).size;encoded=undefined;text=undefined;
      }
      if(configuration.allocation){
        if(global.gc)global.gc();await settle();
        const session=new Session();session.connect();await session.post('HeapProfiler.enable');await session.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
        const at=performance.now();const profiled=runBacktest(dataset,spec);const profiledMs=performance.now()-at;const {profile}=await session.post('HeapProfiler.stopSampling');session.disconnect();assert.deepEqual(profiled.metrics,gold);
        const sums=[];const visit=node=>{sums.push({function:node.callFrame.functionName||'(anonymous)',bytes:node.selfSize});node.children.forEach(visit);};visit(profile.head);
        allocationProfile={samplingIntervalBytes:32768,estimatedAllocatedBytes:sums.reduce((n,v)=>n+v.bytes,0),sampleCount:profile.samples.length,profiledRunMs:profiledMs,includeCollectedObjects:true,scope:'main isolate, separate instrumented run; statistical estimate, not exact total allocations',top:sums.sort((a,b)=>b.bytes-a.bytes).slice(0,8)};
        const atTiming=performance.now();const timed=runBacktest(dataset,spec,{measurePhases:true});instrumentedPhaseTiming={wallMs:performance.now()-atTiming,...timed.timing,note:'Separate diagnostic run; per-event phase clock calls add overhead and are disabled for all normal samples.'};assert.deepEqual(timed.metrics,gold);
      }
    }
    await settle();observer.disconnect();
    const report={id:configuration.id,runtime:process.version,configuration,identity,buildFiles,moduleLoadMs,generationMs,initialNormalizeMs,stages:Object.fromEntries(Object.entries(stages).map(([name,samples])=>[name,aggregate(samples)])),peakRssBytes:process.resourceUsage().maxRSS*1024,resourceUsage:process.resourceUsage(),gcScope:configuration.mode==='sweep'||configuration.mode==='gold'||configuration.mode==='walk_forward'?'main isolate only; worker GC is not observed':'main isolate; observer callbacks drained after every measured interval',memoryNotes:'heap deltas are retained-heap changes, not allocation totals; RSS includes preparation and all phases in this child process',...(lastResult?{result:{metrics:lastResult.metrics,fingerprint:lastResult.fingerprint,timing:lastResult.timing}}:{}),...(research?{research:research.kind==='sweep'?{candidateCount:research.candidateCount,totalCandidateBars:research.candidateCount*dataset.rowCount,workers:configuration.workers??1,sharedDatasetBytes:research.sharedDatasetBytes,winnerId:research.winnerId,fingerprint:research.fingerprint,candidateDigest:createHash('sha256').update(JSON.stringify(research.candidates)).digest('hex'),goldEquivalent:research.goldEquivalent??null,failedCandidates:research.candidates.filter(c=>c.status!=='succeeded').length}:{windowCount:research.windows.length,candidatesPerWindow:3,trainingBudgetBars:3*research.windows.length*dataset.rowCount,continuousBudgetBars:dataset.rowCount,continuousMetrics:research.continuous.metrics,policies:research.policies,windows:research.windows.map(w=>({trainStart:w.trainStart,trainEnd:w.trainEnd,testStart:w.testStart,testEnd:w.testEnd,selectedAt:w.selectedAt,candidate:w.selected.id})),fingerprint:research.fingerprint}}:{}),...(allocationProfile?{allocationProfile,instrumentedPhaseTiming}:{})};
    process.stdout.write(JSON.stringify(report)+'\n');
  }finally{observer.disconnect();await rm(temp,{recursive:true,force:true});}
}

async function isolated(executable,args){
  const at=performance.now();const child=spawn(executable,args,{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'1'}});let stdout='',stderr='',sampledRssBytes=0,samples=0,reading=false;
  child.stdout.on('data',chunk=>{stdout+=String(chunk);});child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  const sampler=setInterval(async()=>{if(reading)return;reading=true;try{const value=await readFile(`/proc/${child.pid}/status`,'utf8');const match=/^VmRSS:\s+(\d+) kB/m.exec(value);if(match){sampledRssBytes=Math.max(sampledRssBytes,Number(match[1])*1024);samples++;}}catch{}finally{reading=false;}},20);
  const [code,signal]=await once(child,'exit');clearInterval(sampler);const wallMs=performance.now()-at;
  if(code!==0)throw new Error(`Benchmark child failed (${code??signal}): ${stderr}\n${stdout.slice(-3000)}`);
  return {report:JSON.parse(stdout),wallMs,sampledRssBytes,rssSampleCount:samples,rssSampleIntervalMs:20,stderr};
}
async function main(){
  const quick=process.argv.includes('--quick'),finalHot=process.argv.includes('--final-hot'),samples=Number(process.argv.find(v=>v.startsWith('--samples='))?.split('=')[1]??(quick?2:5));assert.ok(samples>=1);
  const count=quick?2400:240000,large=quick?4800:1000000;
  let cases=[
    {id:'minute_240k',mode:'pipeline',bars:count,allocation:true,...(!quick?{expectedFillCount:2398}:{})},
    {id:'minute_1m',mode:'pipeline',bars:large,...(!quick?{expectedFillCount:9998}:{})},
    {id:'daily_100_symbols_100k',mode:'hot',bars:quick?10000:100000,symbols:100,frequency:'day'},
    {id:'daily_1000_symbols_1m',mode:'hot',bars:quick?100000:1000000,symbols:1000,frequency:'day'},
    {id:'partial_high_turnover_24k',mode:'pipeline',bars:quick?2400:24000,partial:true,fullTrace:true},
    {id:'no_trade_240k',mode:'hot',bars:count,noTrade:true,expectedFillCount:0},
    {id:'missing_suspension_actions_10k',mode:'hot',bars:10000,symbols:4,frequency:'day',edge:true},
    {id:'sweep_gold_8x2400',mode:'gold',bars:2400,candidates:8,workers:1},
    ...[1,4].flatMap(workers=>[{id:`sweep_100x24000_workers${workers}`,mode:'sweep',bars:quick?2400:24000,candidates:quick?4:100,workers},{id:`sweep_1000x2400_workers${workers}`,mode:'sweep',bars:2400,candidates:quick?8:1000,workers}]),
    {id:'walk_forward_3_windows',mode:'walk_forward',bars:2400},
  ];
  if(finalHot) cases=[{id:'final_minute_240k',mode:'hot',bars:240000,expectedFillCount:2398},{id:'final_minute_1m',mode:'hot',bars:1000000,expectedFillCount:9998},{id:'final_edge_cases_10k',mode:'hot',bars:10000,symbols:4,frequency:'day',edge:true}];
  const report={schemaVersion:'1',finalHot,createdAt:new Date().toISOString(),quick,samplePolicy:{count:samples,percentiles:'nearest-rank; with five samples p95 is the maximum, not a robust tail estimate',normalRuns:'No CPU/heap profiler and measurePhases disabled. One unmeasured JIT warm-up precedes hot-engine samples; pipeline samples follow hot runs.',io:'Buffered filesystem I/O, no fsync and no OS page-cache purge. End-to-end starts at CSV import and ends after atomic result publication; fixture creation and module startup are excluded.',rss:'Each case is a separate process. Linux resourceUsage.maxRSS supplies the process high-water mark; parent /proc VmRSS is additionally sampled every 20 ms. Both include dataset preparation and all case phases.',gc:'PerformanceObserver records are drained outside timed intervals; only events starting inside each interval are counted. Sweeps have separate worker isolates whose GC is not included.',concurrency:'Scenarios run serially; each multiworker sweep uses four workers. This is a shared development machine, not a reserved benchmark host.'},environment:{node:process.version,versions:process.versions,platform:process.platform,arch:process.arch,osRelease:osRelease(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,availableParallelism:availableParallelism(),totalMemoryBytes:totalmem(),loadAverageStart:loadavg()},coldStartup:[],cases:[]};
  const runtimes=[process.execPath];try{await stat(resolve(root,'.cache/node22/node'));runtimes.push(resolve(root,'.cache/node22/node'));}catch{}
  for(const executable of runtimes){
    for(const [kind,path] of [['source',pathToFileURL(resolve(root,'dist/src/index.js')).href],['bundle',pathToFileURL(resolve(root,'dist/package/ts-backtest/core.cjs')).href]]){
      const values=[];for(let i=0;i<samples;i++){const child=await isolated(executable,['--input-type=module','-e',`await import(${JSON.stringify(path)});process.stdout.write(JSON.stringify({runtime:process.version,peakRssBytes:process.resourceUsage().maxRSS*1024}));`]);values.push({ms:child.wallMs,peakRssBytes:child.report.peakRssBytes,nodeVersion:child.report.runtime});}
      report.coldStartup.push({kind,runtime:executable,nodeVersion:values[0].nodeVersion,measurement:'Fresh Node process and module import; OS file cache is not cleared',...aggregate(values)});
    }
  }
  const output=resolve(root,quick?'benchmark-output/quick-benchmark.json':finalHot?'docs/evidence/benchmark-final-hot.json':'docs/evidence/benchmark.json');await mkdir(dirname(output),{recursive:true});
  const save=()=>writeFile(output,JSON.stringify(report,null,2));await save();
  for(const configuration of cases){
    process.stderr.write(`[benchmark] ${configuration.id}: ${configuration.bars} rows; ${samples} samples\n`);
    const child=await isolated(process.execPath,['--expose-gc',self,'--child',JSON.stringify({...configuration,samples})]);report.cases.push({...child.report,processWallMs:child.wallMs,parentSampledRssBytes:child.sampledRssBytes,rssSampleCount:child.rssSampleCount});await save();
    process.stderr.write(`[benchmark] ${configuration.id} complete: ${Object.entries(child.report.stages).map(([name,v])=>`${name} p50=${v.p50Ms.toFixed(2)}ms`).join(', ')}\n`);
  }
  if(runtimes.length>1){const configuration={id:'node22_minute_240k',mode:'hot',bars:count,samples,...(!quick?{expectedFillCount:2398}:{})};process.stderr.write('[benchmark] Node 22 core parity and throughput\n');const child=await isolated(runtimes[1],['--expose-gc',self,'--child',JSON.stringify(configuration)]);report.cases.push({...child.report,processWallMs:child.wallMs,parentSampledRssBytes:child.sampledRssBytes,rssSampleCount:child.rssSampleCount});}
  const sequential=report.cases.filter(c=>c.id.includes('workers1'));for(const item of sequential){const parallel=report.cases.find(c=>c.id===item.id.replace('workers1','workers4'));assert.equal(item.research.candidateDigest,parallel.research.candidateDigest);assert.equal(item.research.fingerprint,parallel.research.fingerprint);}
  report.environment.loadAverageEnd=loadavg();report.finishedAt=new Date().toISOString();report.complete=true;await save();process.stdout.write(JSON.stringify({output,caseCount:report.cases.length,complete:true,quick})+'\n');
}
if(process.argv[2]==='--child')await runChild(JSON.parse(process.argv[3]));else await main();
