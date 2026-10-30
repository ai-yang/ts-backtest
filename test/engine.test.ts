import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset } from '../src/data/normalize.js';
import { runBacktest, validateBacktest } from '../src/engine/run.js';
import { input, spec, sessions, openAt, closeAt, instrument } from './helpers.js';
import type { Action, BacktestSpec } from '../src/spec/types.js';

const ruleSpec = (action: Action): BacktestSpec => spec({strategy:{kind:'rules',nodes:{},rules:[{when:{op:'eq',args:[{field:'close'},{value:10}]},action}]}});

test('golden next-open roundtrip: cash, positions and ledger reconcile exactly', () => {
  const result = runBacktest(normalizeDataset(input()), spec());
  assert.equal(result.metrics.finalEquity, '1100.00');
  assert.equal(result.metrics.netProfit, '100.00');
  assert.deepEqual(result.fills.map(f => [f.at,f.side,f.quantity,f.price,f.cashAfter]), [
    [openAt(sessions[1]!), 'buy',100,'10','0.00'], [openAt(sessions[3]!), 'sell',100,'11','1100.00'],
  ]);
  assert.equal(result.events.reduce((sum,e)=>sum+Number(e.cashDelta),0),1100);
  assert.equal(result.events.reduce((sum,e)=>sum+(e.quantityDelta??0),0),0);
});

test('next-open price gap downsizes with exact fees without borrowing', () => {
  const s=spec(); const d=input(['10','20','20','20','20']);
  s.costs.periods[0]!.minimumCommission='5';
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills[0]!.quantity,49);
  assert.equal(r.fills[0]!.cashAfter,'15.00');
  assert.equal(r.fills[0]!.price,'20');
  assert.ok(r.fills.every(f=>Number(f.cashAfter)>=0));
});

test('evaluation end is exclusive, with no synthetic liquidation',()=>{
  const s=spec({end:closeAt(sessions[1]!)});
  if(s.strategy.kind==='targets')s.strategy.schedule=s.strategy.schedule.slice(0,1);
  const d=input(['10','10','999','999','999']);
  d.bars[1]!.high='100'; d.bars[1]!.close='100';
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.metrics.finalEquity,'1000.00');
  assert.equal(r.fills.length,1);
  assert.ok(r.equity.every(e=>e.at<s.end));
});

test('DAY orders expire on their submission session and GTC survives',()=>{
  const d=input(['10','11','11','11','11']);
  const day=runBacktest(normalizeDataset(d),ruleSpec({type:'order',side:'buy',quantity:10,orderType:'market',tif:'day'}));
  assert.equal(day.fills.length,0); assert.equal(day.orders[0]!.reason,'DAY_EXPIRED');
  const gtc=runBacktest(normalizeDataset(d),ruleSpec({type:'order',side:'buy',quantity:10,orderType:'market',tif:'gtc'}));
  assert.equal(gtc.fills[0]!.at,openAt(sessions[1]!));
});

test('limit orders receive opening improvement and never violate their limit after slippage',()=>{
  const s=ruleSpec({type:'order',side:'buy',quantity:10,orderType:'limit',price:'10',tif:'gtc'});
  s.execution.slippage.bps=3000;
  const r=runBacktest(normalizeDataset(input(['10','8','11','11','11'])),s);
  assert.equal(r.fills[0]!.price,'10');
});

test('stop orders gapped through trigger use open quote; partial remainder stays triggered',()=>{
  const s=ruleSpec({type:'order',side:'buy',quantity:100,orderType:'stop',price:'11',tif:'gtc'});
  const d=input(['10','12','9','9','9']); d.bars.forEach(b=>b.volume=40);
  const r=runBacktest(normalizeDataset(d),s);
  assert.deepEqual(r.fills.map(f=>[f.quantity,f.price]),[[40,'12'],[40,'9'],[17,'9']]);
  assert.equal(r.fills[1]!.at,openAt(sessions[2]!));
});

test('protective stop gaps execute at the gap opening, not at the stale trigger or close',()=>{
  const s=spec(); s.execution.stopLossPct=.1;
  if(s.strategy.kind==='targets')s.strategy.schedule=s.strategy.schedule.slice(0,1);
  const r=runBacktest(normalizeDataset(input(['10','10','7','7','7'])),s);
  assert.equal(r.fills[1]!.at,openAt(sessions[2]!));
  assert.equal(r.fills[1]!.price,'7');
  assert.match(r.fills[1]!.reason,/protective_stop:open/);
});

test('ambiguous same-bar protective levels use conservative stop-first or reject explicitly',()=>{
  const d=input();d.bars[1]!.high='12';d.bars[1]!.low='8';
  const s=spec();s.execution.stopLossPct=.1;s.execution.takeProfitPct=.1;
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills[1]!.price,'9');
  assert.ok(r.warnings.some(w=>w.code==='AMBIGUOUS_BAR_CONSERVATIVE'));
  s.execution.intrabarPolicy='reject';
  assert.throws(()=>runBacktest(normalizeDataset(d),s),{code:'AMBIGUOUS_BAR'});
});

test('price-band checks include adverse slippage',()=>{
  const d=input();d.bars.forEach(b=>{b.limitUp='11';b.limitDown='9';b.high='10';b.low='10';b.open='10';b.close='10';});
  const s=spec();s.execution.slippage.bps=1000;
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills.length,0);
});

test('cancel hook cannot return a completed result and linked preflight detects wrong dataset',()=>{
  const d=normalizeDataset(input());
  assert.throws(()=>runBacktest(d,spec(),{canceled:()=>true}),{code:'CANCELED'});
  assert.throws(()=>validateBacktest(d,spec({datasetId:'missing'})),{code:'DATASET_MISMATCH'});
});

test('seeded stochastic slippage and causal prefix produce deterministic fills',()=>{
  const s=spec();s.execution.slippage={type:'uniform_bps',bps:50};
  const d=normalizeDataset(input());
  assert.deepEqual(runBacktest(d,s).fills,runBacktest(d,s).fills);
  const longer=input(['10','10','12','11','11','50','1']);
  assert.deepEqual(runBacktest(d,s).fills,runBacktest(normalizeDataset(longer),s).fills);
});

test('protective exits supersede reserved discretionary sells',()=>{
  const s=spec({strategy:{kind:'rules',nodes:{},rules:[
    {when:{op:'eq',args:[{state:'position'},{value:0}]},action:{type:'target_quantity',value:10}},
    {when:{op:'gt',args:[{state:'position'},{value:0}]},action:{type:'order',side:'sell',quantity:10,orderType:'limit',price:'20',tif:'gtc'}},
  ]}});
  s.execution.stopLossPct=.1;
  const r=runBacktest(normalizeDataset(input(['10','10','7','7','7'])),s);
  const exit=r.fills.find(f=>f.reason==='protective_stop:open');
  assert.equal(exit?.price,'7');
  assert.ok(r.orders.some(o=>o.reason==='PROTECTIVE_OVERRIDE'));
});

test('intrabar entry and possible exit is explicit OHLC ambiguity',()=>{
  const d=input(['10','11','11','11','11']);d.bars[1]!.low='8';d.bars[1]!.high='12';
  const s=ruleSpec({type:'order',side:'buy',quantity:10,orderType:'limit',price:'9',tif:'gtc'});
  s.execution.stopLossPct=.05;s.execution.intrabarPolicy='reject';
  assert.throws(()=>runBacktest(normalizeDataset(d),s),{code:'AMBIGUOUS_ENTRY_EXIT'});
  s.execution.intrabarPolicy='conservative';
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills[1]!.price,'8.55');
  assert.ok(r.warnings.some(w=>w.code==='AMBIGUOUS_ENTRY_EXIT_CONSERVATIVE'));
});

test('output levels omit unsaved detail without changing full-resolution metrics',()=>{
  const d=normalizeDataset(input());
  const full=runBacktest(d,spec());
  const trades=runBacktest(d,spec({output:{level:'trades'}}));
  const summary=runBacktest(d,spec({output:{level:'summary'}}));
  assert.deepEqual(summary.metrics,full.metrics);assert.deepEqual(trades.metrics,full.metrics);
  assert.deepEqual(summary.fills,[]);assert.deepEqual(summary.orders,[]);assert.deepEqual(summary.equity,[]);
  assert.deepEqual(trades.fills,full.fills);assert.deepEqual(trades.events,[]);
  assert.ok(full.trace?.length); assert.equal(summary.trace,undefined);
});

test('decision trace records past-only node values, rule outcomes and pre-decision position',()=>{
  const s=spec({strategy:{kind:'rules',nodes:{avg:{op:'sma',args:[{field:'close'}],period:2}},rules:[
    {when:{op:'gt',args:[{field:'close'},{ref:'avg'}]},action:{type:'target_quantity',value:10}},
  ]}});
  const r=runBacktest(normalizeDataset(input()),s);
  assert.equal(r.trace![0]!.values['node:avg'],null);
  assert.equal(r.trace![2]!.values['node:avg'],11);
  assert.equal(r.trace![2]!.rules![0]!.matched,true);
  assert.equal(r.trace![2]!.state.position,0);
  assert.equal(r.trace![3]!.state.position,10);
});

test('proportional allocation assigns affordable rounding residuals deterministically',()=>{
  const d=input(['3','3','3','3','3']);
  d.metadata.instruments.push(instrument('BBB'));
  d.bars.push(...input(['4','4','4','4','4']).bars.map(b=>({...b,symbol:'BBB'})));
  const s=spec();s.account.initialCash='101';
  s.strategy={kind:'targets',schedule:[{at:closeAt(sessions[0]!),availableAt:closeAt(sessions[0]!),quantities:{AAA:100,BBB:100}}]};
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills.at(-1)!.cashAfter,'0.00');
  assert.equal(r.fills.filter(f=>f.symbol==='AAA').reduce((sum,f)=>sum+f.quantity,0),15);
  assert.equal(r.fills.filter(f=>f.symbol==='BBB').reduce((sum,f)=>sum+f.quantity,0),14);
});

test('explicit split adjustment retains pending order identity, price audit and cumulative minimum',()=>{
  const d=input(['10','10','5','5','5']);d.bars.forEach(b=>b.volume=40);
  d.actions=[{type:'split',symbol:'AAA',at:openAt(sessions[2]!),ratio:'2'}];
  const s=ruleSpec({type:'order',side:'buy',quantity:100,orderType:'limit',price:'10',tif:'gtc'});
  s.strategy={kind:'rules',nodes:{},rules:[{when:{op:'and',args:[{op:'eq',args:[{state:'position'},{value:0}]},{op:'eq',args:[{field:'close'},{value:10}]}]},action:{type:'order',side:'buy',quantity:100,orderType:'limit',price:'10',tif:'gtc'}}]};
  s.execution.splitOrderPolicy='adjust'; s.costs.periods[0]!.minimumCommission='5';
  s.account.initialCash='2000';
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.orders.length,1);assert.equal(r.orders[0]!.quantity,200);
  assert.equal(r.orders[0]!.price,'5');assert.equal(r.orders[0]!.adjustments?.[0]!.priorRemaining,60);
  assert.equal(r.metrics.fees,'5.00');assert.equal(r.fills.at(-1)!.positionAfter,200);
  assert.equal(r.metrics.finalEquity,'1995.00');
});

test('booked executions replay to the same exact account with fees and partial fills',()=>{
  const d=input(['10','10','12','11','11']);d.bars.forEach(b=>b.volume=40);
  const dataset=normalizeDataset(d);const s=spec();s.costs.periods[0]!.minimumCommission='5';
  const original=runBacktest(dataset,s);
  const replay=runBacktest(dataset,{...s,strategy:{kind:'replay',feePolicy:'provided',fills:original.fills.map(f=>({at:f.at,symbol:f.symbol,side:f.side,quantity:f.quantity,price:f.price,fees:f.fees.total}))}});
  for(const key of ['finalEquity','netProfit','fees','fillCount','timeWeightedReturn'] as const)assert.equal(replay.metrics[key],original.metrics[key]);
  assert.deepEqual(replay.fills.map(f=>[f.cashAfter,f.positionAfter]),original.fills.map(f=>[f.cashAfter,f.positionAfter]));
});

test('order audit retains submission, partial fills and run-end expiry timestamps',()=>{
  const d=input();d.bars.forEach(b=>b.volume=40);
  const s=spec({end:closeAt(sessions[2]!)+1});
  s.strategy={kind:'targets',schedule:[{at:closeAt(sessions[0]!),availableAt:closeAt(sessions[0]!),quantities:{AAA:100}}]};
  const r=runBacktest(normalizeDataset(d),s);
  const history=r.orders[0]!.history!;
  assert.deepEqual(history.map(h=>[h.at,h.status,h.remaining]),[
    [closeAt(sessions[0]!),'accepted',100], [openAt(sessions[1]!),'partial',60],
    [openAt(sessions[2]!),'partial',20], [s.end,'expired',20],
  ]);
  assert.equal(history.at(-1)!.reason,'END_OF_RUN');
});

test('instrument identifiers cannot inherit implicit weights from Object.prototype',()=>{
  const d=input();d.metadata.instruments[0]!.symbol='__proto__';d.bars.forEach(b=>b.symbol='__proto__');
  const s=spec({strategy:{kind:'rank',nodes:{},score:{field:'close'},topK:1,descending:true,rebalanceEvery:100,rebalanceUnit:'session',weighting:'equal',grossWeight:1}});
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills[0]!.symbol,'__proto__');assert.equal(r.fills[0]!.quantity,100);
});

test('AC-05 missing quote keeps a GTC intention pending until the next actual bar',()=>{
  const d=input();d.bars.splice(1,1);
  const s=spec({strategy:{kind:'targets',schedule:[{at:closeAt(sessions[0]!),availableAt:closeAt(sessions[0]!),quantities:{AAA:10}}]}});
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills.length,1);assert.equal(r.fills[0]!.at,openAt(sessions[2]!));assert.equal(r.fills[0]!.price,'12');
});

test('AC-07 buy lots and full-position odd-lot sales remain distinct',()=>{
  const d=input(['12','12','8','8','8']);d.metadata.instruments[0]!.lotSize=100;
  d.actions=[{type:'split',symbol:'AAA',at:openAt(sessions[2]!),ratio:'1.5'}];
  const s=spec({strategy:{kind:'targets',schedule:[
    {at:closeAt(sessions[0]!),availableAt:closeAt(sessions[0]!),quantities:{AAA:150}},
    {at:closeAt(sessions[2]!),availableAt:closeAt(sessions[2]!),quantities:{AAA:0}},
  ]}});s.account.initialCash='3000';
  const r=runBacktest(normalizeDataset(d),s);
  assert.deepEqual(r.fills.map(f=>[f.side,f.quantity]),[['buy',100],['sell',150]]);
  assert.equal(r.metrics.finalEquity,'3000.00');assert.ok(r.warnings.some(w=>w.code==='LOT_ROUNDING'));
});

test('AC-20 carried stale marks never become executable quotes and obey stale policy',()=>{
  const d=input();d.bars=d.bars.slice(0,2);d.metadata.instruments.push(instrument('BBB'));
  d.bars.push(...input().bars.map(b=>({...b,symbol:'BBB'})));
  const s=spec();s.execution.maxStaleSessions=0;
  const r=runBacktest(normalizeDataset(d),s);
  assert.equal(r.fills.length,1);assert.ok(r.warnings.some(w=>w.code==='STALE_MARK'));
  assert.equal(r.orders.at(-1)!.reason,'END_OF_RUN');
  s.execution.stalePolicy='error';assert.throws(()=>runBacktest(normalizeDataset(d),s),{code:'STALE_MARK'});
});
