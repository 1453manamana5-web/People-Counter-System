import {build} from "esbuild";
import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";

const dataset = process.argv.includes("--independent") ? "luxnora-reasoning-independent.json" : "luxnora-reasoning.json";
const cases = JSON.parse(await readFile(new URL("../evaluation/"+dataset, import.meta.url)));
const now = Date.parse("2026-11-28T11:00:00+09:00");
const past = {id:"past",eventId:"festival",date:"2025-11-25",ended:1,finalized:2};
const day = {id:"today",eventId:"festival",date:"2026-11-28",end:"15:00"};
const catalog = {days:[day,past]};
const minute = 60_000;
function fixture(state) {
  const opened = now-60*minute;
  const events = Array.from({length:14},(_,i)=>({at:now-(19-i)*minute,direction:i<8?"in":"out",person:"visitor",invalid:false}));
  const current = !["stale","multiple"].includes(state);
  const sealed = ["equalHours","unequalHours"].includes(state);
  return {
    name:"文化祭", mode:"live", now, current, sealed, day:state==="closingSoon"?{...day,end:"11:30"}:day,
    config:{opened,closed:sealed?now:null},
    analysis:["missing","missingAndAlarm"].includes(state)?null:{
      effective:events, entries:8, exits:6, occupancy:state==="contradiction"?99:2, pending:0,
      issues:state==="multiple"?[{code:"端末の連番に欠損または重複"}]:[],
      timeline:events.map((row,i)=>({at:row.at,occupancy:i<8?i+1:15-i})),
    },
    stations:["in","out"].map(role=>({role,mode:"live",status:"approved",lastSeen:now-(state==="stale"?10:0)*minute,
      pending:role==="out"&&state==="multiple"?3:0,alert:role==="out"&&["multiple","stale"].includes(state)?"network":"none",
      camera:!(role==="in"&&["multiple","missingAndAlarm"].includes(state))})),
    prediction:[{at:now+5*minute,occupancy:4,low:2,high:8,entries:10}],
  };
}
function summary(state) {
  if (state==="historyError") throw new Error("Simulated read failure");
  const from=Date.parse(past.date+"T10:00:00+09:00");
  return {id:state==="wrongHistory"?"wrong":past.id,date:past.date,status:"verified",issues:0,
    entries:6,exits:6,duration:60*minute,bounds:{from,to:from+(state==="unequalHours"?45:60)*minute}};
}
async function load(root, baseline) {
  const source = join(root,"management-app/src/luxnora");
  const text = [
    `export {resolveRequest${baseline?", executeRequest":""}} from ${JSON.stringify(join(source,"runtime.ts"))};`,
    baseline ? `export * from ${JSON.stringify(join(source,"history.ts"))};` :
      `export {runPlan} from ${JSON.stringify(join(source,"planner.ts"))};`,
  ].join("\n");
  const {outputFiles:[bundle]} = await build({
    stdin:{contents:text,resolveDir:root},bundle:true,write:false,platform:"node",format:"esm",
  });
  return import("data:text/javascript;base64,"+Buffer.from(bundle.contents).toString("base64"));
}
async function evaluate(root, baseline) {
  const api = await load(root,baseline);
  const runs = [];
  for (const test of cases) {
    const evidence = fixture(test.state);
    const started = performance.now();
    const request = await api.resolveRequest(test.text,undefined,now,"swift",async()=>null);
    let result;
    if (baseline) {
      const answers = api.executeRequest(request,evidence);
      const index = request.plans.findIndex(plan=>plan.intent==="compare"&&plan.previousYear&&typeof plan.period!=="number");
      if(index>=0) {
        let prior;
        try {prior=summary(test.state);} catch {}
        answers[index]=api.previousYearAnswer(request.plans[index],prior);
      }
      result={answers,trace:[]};
    } else {
      result=await api.runPlan(request,{evidence,catalog,signal:new AbortController().signal,read:async()=>summary(test.state)},true);
    }
    const text = result.answers.map(answer=>answer.text).join("\n") || request.message || "";
    const misses = test.match.filter(needle=>!text.includes(needle));
    const unwanted = (test.reject??[]).filter(needle=>text.includes(needle));
    if (test.noProposal && result.answers.some(answer=>answer.plan?.operation||answer.plan?.schedule)) unwanted.push("operation");
    const steps = Object.fromEntries(result.trace.map(({capability})=>[
      capability,result.trace.filter(row=>row.capability===capability).length,
    ]));
    const planOK = !baseline && (!test.method || result.method===test.method) &&
      Object.entries(test.steps??{}).every(([name,count])=>steps[name]===count) &&
      (!test.fallback || result.trace.some(row=>row.status==="fallback"));
    runs.push({name:test.name,matched:!misses.length&&!unwanted.length,planOK,misses,unwanted,text,method:result.method,trace:result.trace,ms:performance.now()-started});
  }
  const times=runs.map(run=>run.ms).sort((a,b)=>a-b);
  return {version:baseline?"3.0":"3.1",cases:runs.length,matched:runs.filter(run=>run.matched).length,
    planChecks:baseline?null:runs.filter(run=>run.planOK).length,
    unexpected:runs.reduce((sum,run)=>sum+run.unwanted.length,0),
    p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],
    failures:runs.filter(run=>!run.matched||!baseline&&!run.planOK)};
}

const baseline = process.argv.slice(2).find(value=>!value.startsWith("--"));
if(baseline) console.log(JSON.stringify(await evaluate(resolve(baseline),true),null,2));
const result=await evaluate(process.cwd(),false);
console.log(JSON.stringify(result,null,2));
if (result.failures.length) process.exitCode=1;
