import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {analyze} from "./counter-app/public/people-counter/ledger.mjs";

const {outputFiles:[compiled]}=await build({stdin:{contents:`
  export * from "./management-app/src/luxnora/core";
  export * from "./management-app/src/luxnora/understanding";
  export * from "./management-app/src/luxnora/planner";
`,resolveDir:process.cwd()},bundle:true,write:false,platform:"node",format:"esm"});
const {processLuxnoraRequest,recognizeCancellation,resolveLanguage,compilePlan}=await import(
  "data:text/javascript;base64,"+Buffer.from(compiled.contents).toString("base64"));

const now=Date.parse("2026-11-28T15:00:00+09:00");
const clock=(date,hour)=>Date.parse(date+"T"+hour+":00+09:00");
const date="2026-11-28", priorDate="2025-11-25";
const opened=clock(date,"09:00"),closed=clock(date,"14:00");
const operations=["in","out"].map((direction,index)=>({id:"event-"+index,eventId:"today",mode:"live",kind:"passage",
  source:"auto",at:opened+(index+1)*60_000,rawAt:opened+(index+1)*60_000,
  person:"visitor",invalid:false,direction,synced:true,device:direction}));
const analysis=analyze(operations,{eventId:"today",mode:"live",opened,closed,now});
const day={id:"today",eventId:"a",date};
const past={id:"past",eventId:"a",date:priorDate,ended:1,finalized:2};
const catalog={days:[past]};
const evidence={scope:"today/live",name:"文化祭",mode:"live",day,now,current:true,sealed:true,analysis,config:{opened,closed},stations:[],prediction:[]};

async function run(evidence,text,read=async()=>undefined) {
  const snapshot={evidence,catalog};
  return processLuxnoraRequest({text,profile:"swift",context:{topics:{}},signal:new AbortController().signal,
    observe:()=>snapshot,allowConfirmation:()=>true,semantic:async()=>assert.fail("Swift never starts Ruri"),read});
}

test("verified comparison gates diagnosis for lower, equal and unverified morning counts",async()=>{
  const text="今日の午前中の来場者数を去年と比べて、少なかったら原因を調べて。設定は何も変えなくていいから";
  const openedBefore=clock(priorDate,"09:00"),closedBefore=clock(priorDate,"14:00");
  const summary={id:"past",date:priorDate,status:"verified",issues:0,entries:2,exits:2,duration:closedBefore-openedBefore,
    bounds:{from:openedBefore,to:closedBefore},window:{entries:2,exits:2,duration:10800000}};
  const lower=await run(evidence,text,async(_day,window)=>{
    assert.deepEqual(window,{from:clock(priorDate,"00:00"),to:clock(priorDate,"12:00")});
    return summary;
  });
  assert.equal(lower.answers[0].comparisonDelta,-1);
  assert.match(lower.answers[1].text,/台帳は開催日全体/);
  assert.equal(lower.request.constraints.readOnly,true);
  const equal=await run(evidence,text,async()=>({...summary,window:{...summary.window,entries:1}}));
  assert.match(equal.answers[1].text,/当てはまらなかった/);
  const pending=await run({...evidence,sealed:false},text,async()=>summary);
  assert.match(pending.answers[1].text,/保留/);
  assert.ok(pending.answers.every(answer=>!answer.plan?.operation&&!answer.plan?.schedule));
});

test("a conditional station diagnosis uses only fresh telemetry for the selected role",async()=>{
  const status={role:"out",mode:"live",status:"approved",lastSeen:now,camera:false,ai:true,pending:0,alert:"camera"};
  const text="出口の端末を確認して。異常が見つかったら理由を調べて";
  const live=await run({...evidence,stations:[status]},text);
  assert.match(live.answers[1].text,/出口.*計測が欠けた可能性/);
  assert.doesNotMatch(live.answers[1].text,/入口/);
  const stale=await run({...evidence,stations:[{...status,lastSeen:now-300_000}]},text);
  assert.match(stale.answers[1].text,/保留/);
});

test("negative operations, expired references and malformed plan dependencies do not request approval",async()=>{
  assert.equal(recognizeCancellation("それはせんといて。").reset,true);
  const plan=await resolveLanguage("設定は何も変えなくていいから。閉場して",{topics:{}},now,"auto",
    async()=>assert.fail("Restricted requests must not enter the semantic fallback"));
  assert.deepEqual(plan.plans,[]);
  assert.throws(()=>compilePlan({plans:[{intent:"issues",readOnly:true}],
    dependencies:[{task:0,after:0,when:"anomaly"}]}),/Invalid goal dependency/);
});
