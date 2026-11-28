import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {analyze} from "./counter-app/public/people-counter/ledger.mjs";

const {outputFiles:[compiled]}=await build({stdin:{contents:`
  export * from "./management-app/src/luxnora/application";
  export * from "./management-app/src/luxnora/capabilities";
  export * from "./management-app/src/luxnora/core";
  export * from "./management-app/src/luxnora/planner";
`,resolveDir:process.cwd()},bundle:true,write:false,platform:"node",format:"esm"});
const api=await import("data:text/javascript;base64,"+Buffer.from(compiled.contents).toString("base64"));

const now=Date.parse("2026-11-28T11:00:00+09:00");
const opened=now-3_600_000;
const at=now-900_000;
const rows=[{id:"one",eventId:"day",mode:"live",kind:"passage",at,rawAt:at,
  direction:"in",person:"visitor",synced:true,invalid:false,source:"auto",device:"in"}];
const analysis=analyze(rows,{eventId:"day",mode:"live",opened,closed:null,now});
const evidence={scope:"day/live",name:"展示",mode:"live",now,current:true,config:{opened,closed:null},
  day:{id:"day",eventId:"fair",date:"2026-11-28"},analysis,stations:[],prediction:[]};

async function request(text,view={page:"home",ready:true},source=evidence) {
  const snapshot={evidence:source,catalog:null,view};
  return api.processLuxnoraRequest({text,profile:"swift",context:{topics:{}},signal:new AbortController().signal,
    observe:()=>snapshot,allowConfirmation:()=>true,semantic:async()=>null,read:async()=>undefined});
}

test("capabilities reference registered alternatives and search returns guidance without an operation",async()=>{
  const ids=new Set(api.capabilities.map(entry=>entry.id));
  assert.equal(ids.size,api.capabilities.length);
  for(const item of api.capabilities) {
    assert.ok(item.source&&item.input&&item.requires&&item.output&&item.verify&&item.effect);
    assert.ok(item.related.every(id=>ids.has(id)));
  }
  const result=await request("グラフをPNGで保存する方法");
  assert.ok(result.answers.some(row=>row.source&&row.text.includes("グラフPNG")));
  assert.ok(result.answers.every(row=>!row.target&&!row.plan));
});

test("explicit navigation only selects a view or existing form and checks app scope",async()=>{
  const browsing=await request("退場の通過記録だけを表示して");
  assert.equal(browsing.answers[0].target,"records");
  assert.equal(browsing.answers[0].plan.role,"out");
  assert.equal(browsing.answers[0].plan.readOnly,true);
  const blocked=await request("新規イベントの作成フォームを開いて",{page:"home",ready:false});
  assert.ok(blocked.answers.every(row=>!row.target));
  assert.equal(api.canOpenTarget("arbitrary-target",true,true,false),false);
  assert.equal(api.canOpenTarget("new-event",false,true,true),false);
});

test("chart questions use only the selected in-range time and checked ledger",async()=>{
  const result=await request("ここは何人いた？",{page:"analysis",ready:true,chartAt:at});
  assert.match(result.answers[0].text,/10:45の滞在は1人/);
  const unselected=await request("ここは何人いた？",{page:"analysis",ready:true});
  assert.match(unselected.request.message,/時刻を選んで/);
  const outside=await request("ここは何人いた？",{page:"analysis",ready:true,chartAt:now+1});
  assert.match(outside.answers[0].text,/確認できませんでした/);
  assert.throws(()=>api.compilePlan({plans:[{intent:"event",at,operation:"close",readOnly:false}]}),/Invalid chart selection/);
});

test("an approval proposal is bound to the original scope and version",()=>{
  const binding={proposalScope:"day/live",proposalVersion:0};
  assert.equal(api.matchesProposal(binding,"day/live",0,true),true);
  assert.equal(api.matchesProposal(binding,"day/live",1,true),false);
  assert.equal(api.matchesProposal(binding,"day/test",0,true),false);
  assert.equal(api.matchesProposal(binding,"day/live",0,false),false);
});
