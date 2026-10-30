import type { Drawdown, EquityPoint } from '../spec/types.js';
import { statisticalDifference } from './numeric.js';

class DrawdownState {
  private peakValue = -Infinity;
  private peakAt = 0;
  private bestPeakValue = 0;
  private result?: Drawdown;
  constructor(private readonly percentage: boolean) {}
  add(at: number, value: number): void {
    if (!this.result) { this.peakAt=at;this.peakValue=value;this.bestPeakValue=value;this.result={value:0,peakAt:at,troughAt:at,recoveredAt:at};return; }
    if(this.result.value>0&&this.result.recoveredAt===null&&statisticalDifference(value,this.bestPeakValue)>=0)this.result.recoveredAt=at;
    if(statisticalDifference(value,this.peakValue)>0){this.peakValue=value;this.peakAt=at;return;}
    const difference=statisticalDifference(this.peakValue,value);
    const loss=this.percentage?(this.peakValue>0?difference/this.peakValue:0):difference;
    if(loss>this.result.value){this.bestPeakValue=this.peakValue;this.result={value:loss,peakAt:this.peakAt,troughAt:at,recoveredAt:null};}
  }
  value(): Drawdown { return {...this.result!}; }
}

/** Full-resolution streaming metrics; retention never controls observation frequency. */
export class EquityStatistics {
  first?: EquityPoint;
  last?: EquityPoint;
  count=0;
  sum=0;
  readonly daily=new Map<string,EquityPoint>();
  private readonly percentage=new DrawdownState(true);
  private readonly rawPercentage=new DrawdownState(true);
  private readonly amount=new DrawdownState(false);
  add(point:EquityPoint):void {
    if(!this.first)this.first=point;
    else if(point.session)this.daily.set(point.session,point);
    this.last=point;this.count++;this.sum+=point.equity;
    this.percentage.add(point.at,point.unitNav);this.rawPercentage.add(point.at,point.equity);this.amount.add(point.at,point.equity);
  }
  drawdownPct():Drawdown{return this.percentage.value();}
  rawEquityDrawdownPct():Drawdown{return this.rawPercentage.value();}
  drawdownAmount():Drawdown{return this.amount.value();}
}
