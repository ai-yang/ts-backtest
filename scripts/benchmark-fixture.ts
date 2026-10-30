import type { BacktestSpec, DatasetInput, Instrument } from '../src/spec/types.js';

export function syntheticInput(count: number, symbols = 1, frequency: 'minute' | 'day' = 'minute'): DatasetInput {
  const perSymbol = Math.ceil(count / symbols), perSession = frequency === 'minute' ? 240 : 1;
  const sessions = Array.from({length: Math.ceil(perSymbol/perSession)+2}, (_,i)=>new Date(Date.UTC(2020,0,1+i)).toISOString().slice(0,10));
  const instruments: Instrument[] = Array.from({length:symbols},(_,i)=>({symbol:`S${String(i).padStart(4,'0')}`,type:'stock',currency:'CNY',tickSize:'0.01',lotSize:1,settlementDays:0,allowOddLotSell:true,requirePriceLimits:false}));
  const bars: DatasetInput['bars'] = [];
  for(let symbol=0;symbol<symbols;symbol++)for(let i=0;i<perSymbol && bars.length<count;i++){
    const session=sessions[Math.floor(i/perSession)]!,openTime=Date.parse(`${session}T01:30:00Z`)+(i%perSession)*60_000;
    const closeTime=frequency==='minute'?openTime+60_000:Date.parse(`${session}T07:00:00Z`);
    // Deterministic triangle wave: roughly one roundtrip per 200 bars.
    const phase=i%200,ticks=10000+10*(phase<100?phase:200-phase)+symbol;
    const price=(ticks/100).toFixed(2);
    bars.push({symbol:instruments[symbol]!.symbol,session,openTime,closeTime,open:price,high:price,low:price,close:price,volume:100_000,amount:String(ticks*1000),tradable:true});
  }
  return {metadata:{schemaVersion:'1',timezone:'Asia/Shanghai',frequency,priceAdjustment:'raw',volumeUnit:'shares',amountUnit:'currency',currency:'CNY',calendarVersion:'synthetic-every-date-v1',sessions,instruments,corporateActionsCoverage:'complete',universeMode:'static'},bars,features:[],membership:[],actions:[]};
}
export function syntheticSpec(input: DatasetInput, partial = false): BacktestSpec {
  return {schemaVersion:'1',start:input.bars[0]!.openTime,end:Math.max(...input.metadata.instruments.map(i=>input.bars.findLast(b=>b.symbol===i.symbol)!.closeTime))+1,
    account:{currency:'CNY',initialCash:'1000000',moneyDecimals:2,cashFlows:[]},
    strategy:{kind:'rules',nodes:{fast:{op:'sma',args:[{field:'close'}],period:20},slow:{op:'sma',args:[{field:'close'}],period:50}},rules:[
      {when:{op:'cross_up',args:[{ref:'fast'},{ref:'slow'}]},action:{type:'target_quantity',value:1000}},
      {when:{op:'cross_down',args:[{ref:'fast'},{ref:'slow'}]},action:{type:'close'}},
    ]},costs:{version:'synthetic-explicit-v1',scope:'order',periods:[{from:0,commissionRate:'0.0003',minimumCommission:'5',sellTaxRate:'0.001',transferRate:'0'}]},
    execution:{decisionAt:'bar_close',fillAt:'next_bar_open',slippage:{type:'fixed_bps',bps:2},intrabarPolicy:'conservative',cashAllocation:'proportional',endPositionPolicy:'mark_to_market',participationRate:partial?.0002:.1,maxPositionWeight:1,maxStaleSessions:10,stalePolicy:'warn'},
    analytics:{annualPeriods:252,riskFreeRate:0},output:{level:'summary'},seed:1,
    limits:{maxBars:10_000_000,maxOrders:1_000_000,maxRuntimeMs:3_600_000,maxNodes:1024,maxOutputRows:10_000_000}};
}
