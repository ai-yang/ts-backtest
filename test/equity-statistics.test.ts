import test from 'node:test';
import assert from 'node:assert/strict';
import { EquityStatistics } from '../src/analytics/equity-statistics.js';
import { maximumDrawdown } from '../src/analytics/metrics.js';
import { Ledger } from '../src/accounting/ledger.js';
import { normalizeDataset } from '../src/data/normalize.js';
import type { EquityPoint, Order } from '../src/spec/types.js';
import {input,spec,sessions,openAt} from './helpers.js';

test('streaming drawdowns exactly match independent full-series scans including recovery ties',()=>{
  let state=19;const points:EquityPoint[]=[];
  for(let i=0;i<10_000;i++){
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    const equity=10+(state%10000)/100;
    points.push({at:i,session:String(Math.floor(i/240)),cash:equity,marketValue:0,receivables:0,equity,externalFlow:0,unitNav:equity/100,staleSymbols:[]});
  }
  const stats=new EquityStatistics();points.forEach(p=>stats.add(p));
  assert.deepEqual(stats.drawdownPct(),maximumDrawdown(points,'unitNav',true));
  assert.deepEqual(stats.drawdownAmount(),maximumDrawdown(points,'equity',false));
  assert.equal(stats.sum,points.reduce((sum,p)=>sum+p.equity,0));
  assert.equal(stats.count,points.length);assert.equal(stats.daily.size,42);
});

test('lazy tick marks retain exact terminal equity and exact highs at floating-point precision boundaries',()=>{
  const s=spec();s.account.initialCash='1000000000000000';
  const ledger=new Ledger(s,normalizeDataset(input()));
  const order:Order={id:'large',symbol:'AAA',side:'buy',type:'market',quantity:1,remaining:1,submittedAt:s.start,tif:'gtc',status:'accepted',cumulativeNotional:'0',commissionAccruedRaw:'0',commissionPaid:'0',source:'test'};
  ledger.setMarkTicks('AAA',9007199254740990,s.start,0);
  ledger.fill(order,1,'90071992547409.90',s.start,0);
  ledger.setMarkTicks('AAA',9007199254740991,openAt(sessions[1]!),1);
  assert.equal(ledger.markExact('AAA').toFixed(),'90071992547409.91');
  assert.equal(ledger.holdingHighExact('AAA').toFixed(),'90071992547409.91');
  assert.equal(ledger.money(ledger.equityExact()),'1000000000000000.01');
});

test('summary retains all observations in streaming statistics without retaining full point/event arrays',()=>{
  const s=spec({output:{level:'summary'}});const ledger=new Ledger(s,normalizeDataset(input()));
  for(let i=1;i<=10000;i++)ledger.recordEquity(s.start+i,0);
  assert.equal(ledger.equity.length,0);assert.equal(ledger.events.length,0);
  assert.equal(ledger.statistics.count,10001);assert.equal(ledger.statistics.drawdownPct().value,0);
});
