import type {Answer, Evidence} from "./assistant";
import {answer, luxRange} from "./assistant";
import type {Plan, Deliverable} from "./language";
import type {observeLedger, observeStations} from "./reasoning";

export type StationRows = ReturnType<typeof observeStations>;
type Ledger = ReturnType<typeof observeLedger>;
export type Objective = {
  result: Deliverable;
  scope: string | undefined;
  target: Plan["role"];
  period: Plan["period"];
  readOnly: true;
};
type StationReport = {side:"in"|"out"; status:"current"|"cached"; count:number; at:number};
type Fact = {
  current: StationRows;
  currentReport: StationReport;
  cachedReport: StationReport;
};
type FactKey = keyof Fact;
type Facts = Partial<Fact>;
type Provider<K extends FactKey = FactKey> = {
  output: K;
  requires: readonly FactKey[];
  cost: number;
  verify: (facts:Facts, side:"in"|"out", objective:Objective) => Fact[K] | undefined;
};

const sideName = {in:"入口",out:"出口"};
function observedReport(facts:Facts, side:"in"|"out", objective:Objective, fresh:boolean):StationReport|undefined {
  const row=facts.current?.find(item=>item.value.side===side);
  const count=row?.value.station?.pending;
  const at=row?.observedAt;
  if(!row||objective.scope!==undefined&&row.scope!==objective.scope||count==null||
      !Number.isSafeInteger(count)||count<0||at===undefined||!Number.isFinite(at)||at>row.evaluatedAt) return;
  if(fresh ? row.quality!=="current" : row.quality!=="partial") return;
  return {side,count,at,status:fresh?"current":"cached"};
}

const providers:readonly Provider[]=[
  {output:"currentReport", requires:["current"], cost:1,verify:(facts,side,objective)=>observedReport(facts,side,objective,true)},
  {output:"cachedReport", requires:["current"], cost:2,verify:(facts,side,objective)=>observedReport(facts,side,objective,false)},
];

export function structureObjective(plan:Plan,evidence:Evidence):Objective|undefined {
  if(!plan.deliverable) return;
  return {result:plan.deliverable,scope:evidence.scope,target:plan.role,period:plan.period,readOnly:true};
}

// Backward search considers only producers for the requested alternatives.
// The forward mode expands every reachable producer for comparison.
export function searchObjective(available:readonly FactKey[], wanted:readonly FactKey[], mode:"backward"|"forward"="backward") {
  const reachable=new Set(available);
  const examined=new Set<Provider>();
  const ordered:Provider[]=[];
  const orderedCandidates=[...providers].sort((a,b)=>a.cost-b.cost).slice(0,8);
  function visit(key:FactKey, depth:number):boolean {
    if(reachable.has(key)) return true;
    if(depth>=4) return false;
    const candidates=orderedCandidates.filter(provider=>provider.output===key);
    for(const provider of candidates) {
      examined.add(provider);
      if(!provider.requires.every(fact=>visit(fact,depth+1))) continue;
      ordered.push(provider);
      reachable.add(key);
      return true;
    }
    return false;
  }
  if(mode==="backward") wanted.forEach(key=>visit(key,0));
  else for(let level=0;level<4;level++) {
    let advanced=false;
    for(const provider of orderedCandidates) {
      if(reachable.has(provider.output)) continue;
      examined.add(provider);
      if(!provider.requires.every(fact=>reachable.has(fact))) continue;
      ordered.push(provider);
      reachable.add(provider.output);
      advanced=true;
    }
    if(!advanced) break;
  }
  return {providers:ordered, examined:examined.size};
}

export function pendingAnswer(objective:Objective, rows:StationRows):Answer {
  const plan=searchObjective(["current"],["currentReport","cachedReport"]);
  const sides=objective.target?[objective.target]:["in","out"] as const;
  const evidence:StationReport[]=[];
  const missing:string[]=[];
  const lines=sides.map(side=>{
    let report:StationReport|undefined;
    for(const provider of plan.providers) {
      const value=provider.verify({current:rows},side,objective);
      if(value&&!Array.isArray(value)) {report=value;break;}
    }
    if(!report) {
      missing.push(side);
      return sideName[side]+"の未同期件数は確認できません。";
    }
    evidence.push(report);
    return sideName[side]+"の未同期は "+report.count+"件です（"+
      (report.status==="current"?"端末の最新報告":"過去の端末報告。現在の件数は未確認")+"）。";
  });
  // Required information is rendered before optional alerts even when the alert is severe.
  for(const {value:{side,station},quality} of rows) {
    if(quality==="current"&&station?.alert==="camera") lines.push(sideName[side]+"ではカメラ異常も報告されています。");
  }
  const current=missing.length===0&&evidence.every(item=>item.status==="current");
  return {text:lines.join("\n"),source:evidence.length?"選択中の運用区分の承認済み端末報告":undefined,
    objective:{result:objective.result,status:current?"verified":evidence.length?"partial":"missing",
      reported:evidence,missing:[...missing,...evidence.filter(row=>row.status==="cached").map(row=>row.side)]}};
}

export function currentComparisonFallback(plan:Plan, evidence:Evidence, ledger:Ledger):Answer|undefined {
  if(!ledger.value?.consistent || ledger.value.issues.length || ledger.value.occupancy<0 ||
      ledger.from===undefined||ledger.to===undefined||plan.comparisonMetric==="occupancy") return;
  const range=luxRange(plan.period,ledger.from,ledger.to);
  if(range.from>=range.to) return;
  const local=answer({intent:plan.comparisonMetric==="exits"?"exits":"entries",period:plan.period,
    focus:false,readOnly:true},evidence);
  return {text:local.text,source:"選択中の開催日の通過台帳"};
}
