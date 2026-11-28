import {resolve} from "node:path";
import {readFile,writeFile} from "node:fs/promises";
import {build} from "esbuild";
import {independent} from "./independent.mjs";
import {cases,fixture} from "./scenarios.mjs";
import {classify} from "../luxnora-v53/inference.mjs";

export async function bundle(root=process.cwd(),browser=false) {
  const prefix=resolve(root,"management-app/src/luxnora");
  const names=["core","context","planner"];
  if(root===process.cwd()) names.push("objective");
  const {outputFiles:[file]}=await build({stdin:{resolveDir:root,contents:names.map(name=>
    `export * from ${JSON.stringify(prefix+"/"+name+".ts")};`).join("\n")},
    bundle:true,write:false,platform:browser?"browser":"node",format:"esm"});
  return file.text;
}

function unsafe(result) {
  return [...result.request.plans,...result.answers.flatMap(item=>item.plan?[item.plan]:[])]
    .some(plan=>plan.operation||plan.schedule||plan.intent==="routine"&&!plan.readOnly);
}

function verify(key,result,environment,row) {
  const {snapshot,out,history}=environment;
  const text=result.answers.map(answer=>answer.text).join("\n")||result.request.message||"";
  const initialDenied=!snapshot.view.ready;
  if(initialDenied||row.revoke) return /閲覧権限/.test(text)&&!/999|未同期は \d+件|入場 \d+回/.test(text);
  const expected={
    pending:()=>snapshot.evidence.stations.filter(station=>station.mode===snapshot.evidence.mode&&station.role==="out").length===0||
      row.kind==="malformed"?/出口の未同期件数は確認できません/.test(text):
      text.includes("未同期は "+out+"件")&&(row.kind!=="stale"||text.includes("現在の件数は未確認")),
    reason:()=>text.includes("原因")&&/確定することはできません|原因は判断できません|前年を下回っていません/.test(text)&&
      (row.kind==="test"||!history||row.kind==="ambiguous-history"?text.includes("入場 1回")&&!result.answers.some(a=>a.comparisonDelta!==undefined):
        result.answers.some(a=>a.comparisonDelta===-7)),
    past:()=>row.kind==="test"||!history||row.kind==="ambiguous-history"?/前年の確定日|年度比較を表示/.test(text):/前年|2025-11-28/.test(text),
    conditional:()=>row.kind==="test"||!history||row.kind==="ambiguous-history"?/保留/.test(text):/原因|台帳/.test(text),
    setup:()=>text.includes("A・B")&&text.includes("試"),
    export:()=>text.includes("CSV")&&text.includes("出力"),
    entry:()=>text.includes("入場 1回"),
    "exit-count":()=>text.includes("退場 1回"),
    exit:()=>text.includes("出口"),
    am:()=>result.request.plans.length===1&&result.request.plans[0].intent==="compare"&&result.request.plans[0].period==="am",
    pm:()=>result.request.plans.length===1&&result.request.plans[0].intent==="compare"&&result.request.plans[0].period==="pm",
    clarify:()=>!result.request.plans.length&&/どの|対象|特定/.test(text),
    forbidden:()=>false,
    "higher-premise":()=>text.includes("前年を上回っていません")||
      /差の原因は判断できません/.test(text),
    "entrance-pending":()=>text.includes("入口の未同期は 0件"),
    advice:()=>text.includes("次回")&&text.includes("試験通過"),
    occupancy:()=>text.includes("滞在 0人"),
    ledger:()=>text.includes("差し引き"),
    offline:()=>text.includes("保存")&&text.includes("通信"),
    "no-pending-number":()=>!result.answers.some(answer=>answer.objective?.reported?.length)&&
      /指定|条件|時間帯|対象/.test(text),
    "safe-hold":()=>!unsafe(result)&&/操作|別々|特定でき|指定/.test(text),
    "entries-am":()=>result.request.plans.some(plan=>plan.intent==="entries"&&plan.period==="am"),
    "exits-am":()=>result.request.plans.some(plan=>plan.intent==="exits"&&plan.period==="am"),
    entrance:()=>text.includes("入口"),
  };
  return expected[key]();
}

export async function evaluate(api,rows,model) {
  const summary={cases:rows.length,conversations:0,complete:0,completeConversations:0,obligations:0,met:0,
    pendingRequests:0,pendingMisses:0,unsafe:0,unsupportedPending:0,reads:0,shadowCandidates:0, shadowFinalScored:0,shadowFinalPassed:0,byStructure:{}};
  const failures=[],times=[];
  for(const row of rows) {
    const env=fixture(row.kind,row.i);
    const {snapshot,history}=env;
    let state={scope:snapshot.evidence.scope,topics:{}};
    let result,finalPreview,shifts=0;
    const start=performance.now();
    for(const [index,text] of row.turns.entries()) {
      const turn=row.revoke&&index===row.turns.length-1?
        {...snapshot,view:{...snapshot.view,ready:false}}:snapshot;
      result=await api.processLuxnoraRequest({text,context:state,profile:"swift",observe:()=>turn,
        signal:new AbortController().signal,allowConfirmation:()=>turn.view.ready,semantic:async()=>null,
        read:async()=>{summary.reads++;return history;},shadow:model?{
          predict:async request=>classify(model,request),
          report:value=>{shifts++;if(index===row.turns.length-1) finalPreview=value.candidate;},
        }:undefined});
      if(!result) throw Error("Fixture unexpectedly cancelled");
      state=api.rememberOutcomes(result.request,state,Date.now(),result.answers);
      summary.unsafe+=+unsafe(result);
      for(const answer of result.answers) for(const fact of answer.objective?.reported??[]) {
        const source=snapshot.evidence.stations.find(item=>item.mode===snapshot.evidence.mode&&
          item.role===fact.side&&item.status==="approved");
        summary.unsupportedPending+=+(source?.pending!==fact.count||source?.lastSeen!==fact.at);
      }
    }
    if(model) await new Promise(resolve=>setImmediate(resolve));
    summary.shadowCandidates+=shifts;
    times.push(performance.now()-start);
    const checks=row.check.map(key=>verify(key,result,env,row));
    const referenceChecks=row.check.filter(key=>["am","pm","entries-am","exits-am","clarify"].includes(key));
    if(finalPreview&&referenceChecks.length&&snapshot.view.ready&&!row.revoke) {
      summary.shadowFinalScored++;
      summary.shadowFinalPassed+=+referenceChecks.every(key=>verify(key,{request:finalPreview,answers:[]},env,row));
    }
    const ok=checks.every(Boolean);
    const structure=summary.byStructure[row.structure]??={cases:0,complete:0};
    structure.cases++;
    structure.complete+=+ok;
    summary.conversations+=+(row.turns.length>1);
    summary.completeConversations+=+(ok&&row.turns.length>1);
    summary.complete+=+ok;
    summary.obligations+=checks.length;
    summary.met+=checks.filter(Boolean).length;
    summary.pendingRequests+=+row.check.includes("pending");
    summary.pendingMisses+=+(row.check.includes("pending")&&!checks[row.check.indexOf("pending")]);
    if(!ok) failures.push({id:row.id,kind:row.kind,turns:row.turns,missing:row.check.filter((_,i)=>!checks[i]),
      plans:result.request.plans,answers:result.answers.map(answer=>answer.text)});
  }
  times.sort((a,b)=>a-b);
  return {summary,p95Ms:times[Math.ceil(times.length*.95)-1],failures};
}

if(process.argv[1]?.endsWith("/evaluate.mjs")) {
  const [base,artifacts]=process.argv.slice(2);
  const run=async root=>import("data:text/javascript;base64,"+Buffer.from(await bundle(root)).toString("base64"));
  const data=independent();
  const current=await run(process.cwd());
  const previous=await run(base);
  const model=JSON.parse(await readFile("research/luxnora-v53/artifacts/state.json","utf8"));
  const old=await evaluate(previous,data);
  const now=await evaluate(current,data,model);
  const search=["backward","forward"].map(mode=>{
    const candidates=[["currentReport"],["cachedReport"],["currentReport","cachedReport"]];
    return {mode,samples:candidates.map(wants=>{
      const value=current.searchObjective(["current"],wants,mode);
      return {wants,examined:value.examined,providers:value.providers.map(provider=>provider.output)};
    })};
  });
  const regression=cases();
  const regressionResults={old:await evaluate(previous,regression),now:await evaluate(current,regression)};
  await writeFile(resolve(artifacts,"cases.json"),JSON.stringify(data,null,2)+"\n");
  await writeFile(resolve(artifacts,"regression.json"),JSON.stringify(regressionResults,null,2)+"\n");
  await writeFile(resolve(artifacts,"core.json"),JSON.stringify({old,now,search},null,2)+"\n");
  console.log({before:old.summary,after:now.summary,search});
}
