import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { input,spec,instrument,sessions,closeAt } from './helpers.js';
import type { BacktestSpec } from '../src/spec/types.js';
const execute=promisify(execFile);
const sweep={space:{'/strategy/rules/0/action/value':[1,2]},objective:{metric:'netProfit',direction:'maximize'},concurrency:1,seed:42};
const walk={...sweep,trainSessions:2,testSessions:2,mode:'rolling',warmup:'all_prior',positionPolicy:'carry',pendingOrderPolicy:'carry'};
async function files(){
  const root=await mkdtemp(join(tmpdir(),'research-adapter-')),data=input(['10','10','12','13','14','15','16','17']);
  const originals=[...data.bars];
  for(const [symbol,delta] of [['BBB',1],['CCC',2]] as const){data.metadata.instruments.push(instrument(symbol));data.bars.push(...originals.map(b=>({...b,symbol,open:String(Number(b.open)+delta),high:String(Number(b.high)+delta),low:String(Number(b.low)+delta),close:String(Number(b.close)+delta)})));}
  data.features=data.metadata.instruments.map((i,index)=>({symbol:i.symbol,name:'score',value:index+1,availableAt:closeAt(sessions[0]!)}));
  const specification:BacktestSpec=spec({end:closeAt(sessions[7]!)+1,strategy:{kind:'rules',nodes:{},rules:[{when:{value:true},action:{type:'target_quantity',value:2}}]}});
  const factors={feature:'score',from:specification.start,to:specification.end,horizonBars:1,groups:2,minSamples:3};
  await writeFile(join(root,'bars.json'),JSON.stringify(data));
  await writeFile(join(root,'config.json'),JSON.stringify({dataset:{path:'bars.json',format:'json'},spec:specification}));
  for(const [name,value] of Object.entries({sweep,walk,factors}))await writeFile(join(root,`${name}.json`),JSON.stringify(value));
  return {root,specification,factors};
}

test('CLI research commands use actual workers and report exports the full-trace run',async()=>{
  const f=await files(),cli=fileURLToPath(new URL('../src/adapters/cli.js',import.meta.url));
  const run=async(args:string[])=>JSON.parse((await execute(process.execPath,[cli,...args],{cwd:f.root,maxBuffer:8*1024*1024})).stdout);
  try{
    const a=await run(['sweep','--config','config.json','--request','sweep.json']);assert.equal(a.kind,'sweep');assert.equal(a.candidateCount,2);
    const b=await run(['walk-forward','--config','config.json','--request','walk.json','--output','study.json']);assert.equal(b.kind,'walk_forward');
    const study=JSON.parse(await readFile(join(f.root,'study.json'),'utf8'));assert.equal(study.continuous.events.filter((e:any)=>e.type==='initial').length,1);
    const c=await run(['factors','--config','config.json','--request','factors.json']);assert.equal(c.kind,'factors');assert.ok(c.observations>0);
    await run(['run','--config','config.json','--output','run.json']);
    const report=await run(['report','--input','run.json','--output','report.html']);assert.equal(report.mimeType,'text/html');
    assert.match(await readFile(join(f.root,'report.html'),'utf8'),/<svg/);
    await assert.rejects(run(['run','--config','config.json','--request','sweep.json']),error=>/INVALID_ARGUMENTS/.test(String((error as any).stdout)));
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('MCP research jobs return bounded study pages, continuous run handles and verified report handles',async()=>{
  const f=await files(),server=fileURLToPath(new URL('../src/adapters/mcp.js',import.meta.url));
  const transport=new StdioClientTransport({command:process.execPath,args:[server,'--workspace',f.root,'--store',join(f.root,'store'),'--workers','2'],stderr:'pipe'});
  const client=new Client({name:'research-acceptance',version:'1'});let stderr='';transport.stderr?.on('data',chunk=>stderr+=chunk);
  const call=async(name:string,args:Record<string,unknown>={})=>{const response=await client.callTool({name,arguments:args});const value=response.structuredContent as any;assert.equal(value.ok,true,JSON.stringify(value.error));return value.data;};
  const wait=async(id:string)=>{for(let i=0;i<500;i++){const job=await call('backtest_job',{jobId:id});if(['succeeded','failed','canceled'].includes(job.state)){assert.equal(job.state,'succeeded',JSON.stringify(job.error));return job.result;}await new Promise(r=>setTimeout(r,10));}throw new Error('job timeout');};
  try{
    await client.connect(transport);
    const datasetId=(await wait((await call('backtest_prepare_data',{path:'bars.json',format:'json'})).id)).datasetId;
    const plan=await call('backtest_validate',{datasetId,spec:f.specification});
    const a=await wait((await call('backtest_sweep',{planId:plan.planId,request:sweep})).id);
    const first=await call('backtest_study',{studyId:a.studyId,table:'candidates',limit:1});assert.equal(first.rows.length,1);assert.ok(first.nextCursor);
    const next=await call('backtest_study',{studyId:a.studyId,table:'candidates',limit:1,cursor:first.nextCursor});assert.notEqual(next.rows[0].id,first.rows[0].id);assert.equal(next.nextCursor,null);
    const b=await wait((await call('backtest_walk_forward',{planId:plan.planId,request:walk})).id);assert.ok(b.runId);
    const windows=await call('backtest_study',{studyId:b.studyId,table:'windows'});assert.equal(windows.rows.length,3);
    const initial=await call('backtest_result',{runId:b.runId,table:'events',filter:{type:'initial'}});assert.equal(initial.matchedRows,1);
    const report=await call('backtest_report',{runId:b.runId});assert.equal(report.mimeType,'text/html');assert.match(report.sha256,/^[a-f0-9]{64}$/);assert.ok(report.bytes>0);
    const c=await wait((await call('backtest_factors',{datasetId,request:f.factors})).id);
    const periods=await call('backtest_study',{studyId:c.studyId,table:'periods',limit:2});assert.equal(periods.rows.length,2);
    const schema=await call('backtest_capabilities',{category:'schema',name:'walk_forward'});assert.equal(schema.schema.type,'object');
  }finally{await client.close();await rm(f.root,{recursive:true,force:true});assert.equal(stderr,'');}
});
