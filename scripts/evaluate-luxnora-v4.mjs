import {build} from "esbuild";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {simulate,passageScenario,scenarios} from "./luxnora-simulator.mjs";

const compare = process.argv[2] ? resolve(process.argv[2]) : undefined;
async function load(root, v4) {
  const source=path=>JSON.stringify(resolve(root,"management-app/src/luxnora",path));
  const entry=[
    `export {runPlan} from ${source("planner.ts")};`,
    `export {resolveRequest,rememberRequest} from ${source("runtime.ts")};`,
    ...(v4?[`export {rememberTopics,recallCorrection} from ${source("context.ts")};`,
      `export {processLuxnoraRequest} from ${source("core.ts")};`]:[]),
  ].join("\n");
  const {outputFiles:[out]}=await build({stdin:{contents:entry,resolveDir:root},
    bundle:true,write:false,platform:"node",format:"esm"});
  const ledger=await import(pathToFileURL(resolve(root,"counter-app/public/people-counter/ledger.mjs")));
  const tracker=await import(pathToFileURL(resolve(root,"counter-app/public/people-counter/tracker.mjs")));
  return {...await import("data:text/javascript;base64,"+Buffer.from(out.contents).toString("base64")),
    ...ledger,...tracker};
}
async function evaluate(root, v4){
  const api=await load(root,v4);
  const operationReport={};
  for(const scenario of scenarios) operationReport[scenario]={cases:0,expected:0,badNumeric:0};
  const durations=[];
  for(let i=0;i<384;i++){
    const kind=scenarios[i%scenarios.length];
    const {truth,operations,evidence}=simulate(i+541,kind);
    const analysis=api.analyze(operations,{eventId:"virtual",mode:"live",
      opened:evidence.config.opened,closed:null,now:evidence.now});
    if(kind==="aggregate-drift") analysis.occupancy+=100;
    if(kind==="timeline-drift") analysis.timeline[0].occupancy+=100;
    evidence.analysis=analysis;
    const signal=new AbortController().signal;
    const anomaly=!["normal","aggregate-drift","timeline-drift"].includes(kind);
    const text=anomaly?"記録に異常はある？":"今何人いる？";
    const started=performance.now();
    let result;
    if(v4) {
      const snapshot={evidence,catalog:null};
      result=await api.processLuxnoraRequest({text,profile:"swift",context:{topics:{}},signal,
        observe:()=>snapshot,allowConfirmation:()=>true,semantic:async()=>null,read:async()=>undefined});
    } else {
      const request=await api.resolveRequest(text,undefined,evidence.now,"swift",async()=>null);
      result=await api.runPlan(request,{evidence,catalog:null,signal,read:async()=>undefined},true);
    }
    durations.push(performance.now()-started);
    const output=result.answers[0]?.text??"";
    const value=/滞在\s*(\d+)人/.exec(output);
    const expectedDiagnostic={
      offline:"現在の端末状態を確認できません","sync-delay":"未同期 3件","camera-stop":"計測が欠けた可能性",
      "lost-out":"欠損","duplicate-in":"同時刻",
    }[kind];
    const expected=kind==="timeline-drift"?output.includes("保留"):anomaly?
      output.includes(expectedDiagnostic):Number(value?.[1])===truth.entries-truth.exits;
    const row=operationReport[kind];
    row.cases++;
    if(expected) row.expected++;
    if(value&&Number(value[1])!==truth.entries-truth.exits) row.badNumeric++;
  }
  const passage={};
  for(const kind of ["single","reverse","two-lanes","occlusion","conflicting-frame"]){
    const outcomes=Array.from({length:64},(_,i)=>{
      const {expected,frames}=passageScenario(i+127,kind);
      let observed=0;
      const tracker=new api.LineTracker(()=>observed++);
      for(const [time,points] of frames) tracker.update(points,time);
      return observed===expected;
    });
    passage[kind]={cases:outcomes.length,expected:outcomes.filter(Boolean).length};
  }
  let focus, context={topics:{}};
  const turns=[];
  for(const text of ["今日と去年の午前中を比較して。あと入口の端末も確認して","比較の方は午後に変えて","端末は出口も追加して"]){
    const fixed=Date.UTC(2026,10,28);
    const request=(v4?api.recallCorrection(text,context,fixed):undefined)??
      await api.resolveRequest(text,v4?context.focus:focus,fixed,"swift",async()=>null);
    turns.push(request.plans.map(({intent,period,role})=>({intent,period,role})));
    if(v4) context=api.rememberTopics(request,context,fixed); else focus=api.rememberRequest(request,focus,fixed);
  }
  durations.sort((a,b)=>a-b);
  return {version:v4?"4.0":"3.1",operationReport,passage,turns,p95Ms:durations[Math.ceil(durations.length*.95)-1]};
}
if(compare) console.log(JSON.stringify(await evaluate(compare,false),null,2));
const result=await evaluate(process.cwd(),true);
console.log(JSON.stringify(result,null,2));
if(Object.values(result.operationReport).some(row=>row.expected!==row.cases||row.badNumeric) ||
   Object.values(result.passage).some(row=>row.expected!==row.cases) ||
   result.turns[0].length!==2 || result.turns[1][0]?.period!=="pm" ||
   result.turns[2].map(plan=>plan.role).join(",")!=="in,out") process.exitCode=1;
