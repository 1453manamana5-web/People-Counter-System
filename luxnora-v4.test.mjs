import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {analyze} from "./counter-app/public/people-counter/ledger.mjs";
import {simulate} from "./scripts/luxnora-simulator.mjs";

const {outputFiles:[compiled]}=await build({
  stdin:{contents:`
    export * from "./management-app/src/luxnora/context";
    export * from "./management-app/src/luxnora/core";
    export * from "./management-app/src/luxnora/memory";
  `,resolveDir:process.cwd()},bundle:true,write:false,platform:"node",format:"esm",
});
const {rememberTopics,recallCorrection,processLuxnoraRequest,loadMemory,saveProfile,rememberExperience,clearMemory}=
  await import("data:text/javascript;base64,"+Buffer.from(compiled.contents).toString("base64"));

test("editing a comparison preserves the independent station topic and expired references are rejected",()=>{
  const now=Date.now();
  const ctx=rememberTopics({plans:[{intent:"compare",period:"am",previousYear:true},
    {intent:"stations",role:"in"}]},{topics:{}},now);
  const revised=recallCorrection("比較の方は午後に変えて",ctx,now);
  assert.deepEqual(revised.plans,[{intent:"compare",period:"pm",previousYear:true}]);
  const next=rememberTopics(revised,ctx,now);
  assert.deepEqual(recallCorrection("端末は出口も追加して",next,now).plans.map(plan=>plan.role),["in","out"]);
  assert.deepEqual(recallCorrection("比較の方は午後に変えて",next,now+300_001).plans,[]);
  assert.equal(recallCorrection("出口だけ確認して",{topics:{}},now),undefined);
});

test("persistent memory isolates account and event, coalesces and expires, and can be cleared",()=>{
  const items=new Map();
  const storage={getItem:key=>items.get(key),setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
  const now=Date.now();
  saveProfile(storage,"operator-a","A/live","swift",now);
  rememberExperience(storage,"operator-a","A/live","ledger-recount",now);
  rememberExperience(storage,"operator-a","A/live","ledger-recount",now+1000);
  assert.equal(loadMemory(storage,"operator-a","A/live",now+2000).experiences[0].repeats,1);
  assert.equal(loadMemory(storage,"operator-a","A/live",now+2000).profile,"swift");
  assert.deepEqual(loadMemory(storage,"operator-b","A/live",now+2000).experiences,[]);
  assert.deepEqual(loadMemory(storage,"operator-a","A/test",now+2000).experiences,[]);
  assert.deepEqual(loadMemory(storage,"operator-a","A/live",now+31*86_400_000).experiences,[]);
  clearMemory(storage,"operator-a","A/live");
  assert.equal(items.size,0);
});

test("core safely repairs a derived count and uses the scoped experience only as diagnostic context",async()=>{
  const {operations,evidence}=simulate(17,"aggregate-drift");
  const source=analyze(operations,{eventId:"virtual",mode:"live",
    opened:evidence.config.opened,closed:null,now:evidence.now});
  const actual=source.occupancy;
  source.occupancy+=400;
  evidence.analysis=source;
  const args={profile:"swift",context:{topics:{}},signal:new AbortController().signal,
    allowConfirmation:()=>false,semantic:async()=>null,read:async()=>undefined};
  const snapshot={evidence,catalog:null};
  const verified=await processLuxnoraRequest({...args,text:"今何人いる？",observe:()=>snapshot});
  assert.equal(verified.answers[0].verification,"recount");
  assert.match(verified.answers[0].text,new RegExp("滞在 "+actual+"人"));
  assert.deepEqual(verified.experiences,["ledger-recount"]);
  assert.equal(source.occupancy,actual+400);
  const experience={kind:"ledger-recount",scope:evidence.scope,at:evidence.now-1000,
    expiresAt:evidence.now+1000,source:"local-verification",repeats:1};
  const diagnose=async experience=>processLuxnoraRequest({...args,text:"記録に異常はある？",
    observe:()=>({...snapshot,experiences:[experience]})});
  assert.match((await diagnose(experience)).answers[0].text,/以前も集計値の再計算/);
  assert.doesNotMatch((await diagnose({...experience,scope:"other/live"})).answers[0].text,/以前も集計値の再計算/);
  const stale={...evidence,ledgerFromServer:false};
  const deferred=await processLuxnoraRequest({...args,text:"今何人いる？",observe:()=>({evidence:stale,catalog:null})});
  assert.equal(deferred.answers[0].verification,undefined);
  assert.match(deferred.answers[0].text,/保留/);
});
