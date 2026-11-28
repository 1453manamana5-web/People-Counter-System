import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const {outputFiles:[out]}=await build({stdin:{contents:`
  export * from "./management-app/src/luxnora/core";
  export * from "./management-app/src/luxnora/session";
`,resolveDir:process.cwd()},bundle:true,write:false,platform:"node",format:"esm"});
const {processLuxnoraRequest,createHistoryMemo}=await import("data:text/javascript;base64,"+Buffer.from(out.contents).toString("base64"));
const now=Date.parse("2026-11-28T11:00:00+09:00");
const day={id:"current",eventId:"series",date:"2026-11-28"};
const past={id:"past",eventId:"series",date:"2025-11-21",closed:now,ended:now,finalized:now,version:2};
const row={id:past.id,date:past.date,status:"verified",issues:0,duration:3600_000,entries:8,exits:8};
const evidence={scope:"current/live",name:"文化祭",now,current:true,mode:"live",day,
  analysis:null,config:null,prediction:[],stations:[]};

test("memo expires and separates version, date, range and current scope",()=>{
  const memo=createHistoryMemo();
  memo.put("current/live",past,undefined,row,now);
  assert.equal(memo.get("current/live",past,undefined,now+1),row);
  assert.equal(memo.get("current/test",past,undefined,now+1),undefined);
  assert.equal(memo.get("current/live",{...past,version:3},undefined,now+1),undefined);
  assert.equal(memo.get("current/live",past,{from:1,to:2},now+1),undefined);
  assert.equal(memo.get("current/live",past,undefined,now+20_000),undefined);
  memo.put("current/live",past,undefined,{...row,issues:1},now);
  assert.equal(memo.get("current/live",past,undefined,now+1),undefined);
});

test("a verified previous-year read is reused until authorization is uncertain",async()=>{
  const memo=createHistoryMemo();
  let reads=0;
  async function run(ready){
    const snapshot={evidence,catalog:{days:[past]},view:{page:"analysis",ready}};
    return processLuxnoraRequest({text:"前年の入場回数を比べて",profile:"swift",context:{topics:{}},observe:()=>snapshot,
      signal:new AbortController().signal,allowConfirmation:()=>false,semantic:async()=>null,
      memo,read:async()=>{reads++;return row;}});
  }
  assert.match((await run(true)).answers[0].text,/入場 8回/);
  assert.match((await run(true)).answers[0].text,/入場 8回/);
  assert.equal(reads,1);
  await run(false);
  assert.equal(reads,2);
  await run(true);
  assert.equal(reads,3);
  const authorized={evidence,catalog:{days:[past]},view:{page:"analysis",ready:true}};
  const later={...authorized,view:{...authorized.view,ready:false}};
  let observations=0;
  const changed=await processLuxnoraRequest({text:"前年の入場回数を比べて",profile:"swift",context:{topics:{}},
    observe:()=>++observations<=3?authorized:later,signal:new AbortController().signal,allowConfirmation:()=>false,
    semantic:async()=>null,memo,read:async()=>assert.fail("Expected the current verified memo")});
  assert.match(changed.answers[0].text,/閲覧権限を再確認/);
  assert.doesNotMatch(changed.answers[0].text,/8回/);
});

test("advice plans are read-only and do not claim success if ledger and stations are missing",async()=>{
  const snapshot={evidence:{...evidence,current:false},catalog:null};
  const result=await processLuxnoraRequest({text:"カウントミスを減らしたい。今年の問題点を調べて準備内容を考えて",
    profile:"auto",context:{topics:{}},observe:()=>snapshot,signal:new AbortController().signal,
    allowConfirmation:()=>true,semantic:async()=>assert.fail("Known preparation workflow should not load Ruri"),
    read:async()=>assert.fail("Current-only review should not read history")});
  assert.deepEqual(result.request.plans.map(x=>[x.intent,x.readOnly]),[["issues",true]]);
  assert.match(result.answers.at(-1).text,/断定できません/);
  assert.ok(result.answers.every(x=>!x.target&&!x.plan?.operation));
});
