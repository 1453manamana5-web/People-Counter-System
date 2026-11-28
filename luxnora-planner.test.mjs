import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const {outputFiles:[output]} = await build({
  stdin:{contents:`
    export * from "./management-app/src/luxnora/planner";
    export * from "./management-app/src/luxnora/taskQueue";
    export * from "./management-app/src/luxnora/runtime";
  `,resolveDir:process.cwd()},bundle:true,write:false,platform:"node",format:"esm",
});
const {runPlan,compilePlan,TaskQueue,resolveRequest} = await import(
  "data:text/javascript;base64," + Buffer.from(output.contents).toString("base64"));
const now=Date.parse("2026-11-28T11:00:00+09:00");
const day={id:"today",date:"2026-11-28",eventId:"a"};
const past={id:"past",date:"2025-11-27",eventId:"a",finalized:1,ended:1};
const evidence={scope:"today/live",name:"文化祭",mode:"live",day,now,current:false,analysis:null,config:null,stations:[],prediction:[]};
const resolve=text=>resolveRequest(text,undefined,now,"swift",async()=>null);
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

test("work shares ledger, preserves response order, and falls back without fetching an ambiguous day",async()=>{
  const request=await resolve("今日の来場状況を分析して、去年と比べて、問題があったら教えて");
  const compiled=compilePlan(request);
  const ids=new Set();
  for(const node of compiled.nodes) {
    assert.ok(node.dependencies.every(dependency=>ids.has(dependency.id)));
    assert.ok(!ids.has(node.id));
    ids.add(node.id);
  }
  let reads=0;
  const result=await runPlan(request,{evidence,catalog:{days:[past,{...past,id:"second"}]},
    read:async()=>{reads++;},signal:new AbortController().signal},true);
  assert.equal(reads,0);
  assert.equal(result.trace.filter(row=>row.capability==="ledger").length,1);
  assert.equal(result.trace.find(row=>row.capability==="historical").status,"fallback");
  assert.match(result.answers[0].text,/集計できる/);
  assert.match(result.answers[1].text,/前年の確定日/);
  assert.match(result.answers[2].text,/開催日の台帳/);
});

test("cancel interrupts a held historical read and suppresses late output",async()=>{
  const controller=new AbortController();
  let signal;
  const request=await resolve("去年と比較して");
  const output=runPlan(request,{evidence,catalog:{days:[past]},signal:controller.signal,
    read:async (_day,_window,child)=>{signal=child;return new Promise(()=>{});}},true);
  await nextTurn();
  assert.ok(signal);
  controller.abort();
  await assert.rejects(output,/cancelled/);
  assert.ok(signal.aborted);
});

test("queue deduplicates, pauses, resumes the interrupted task first and clears pending work",async()=>{
  const started=[],finished=[];
  const q=new TaskQueue(async (task,signal)=>{
    started.push(task.value);
    await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}));
    if(!signal.aborted) finished.push(task.value);
  },()=>{},()=>assert.fail("aborted tasks must not fail"));
  assert.equal(q.enqueue("a","a"),"accepted");
  assert.equal(q.enqueue("a","a"),"duplicate");
  assert.equal(q.enqueue("b","b"),"accepted");
  q.pause();
  q.pause();
  await nextTurn();
  assert.deepEqual(started,["a"]);
  q.resume();
  await nextTurn();
  assert.deepEqual(started,["a","a"]);
  q.cancel();
  await nextTurn();
  assert.deepEqual(started,["a","a"]);
  assert.deepEqual(finished,[]);
  q.dispose();
});

test("execution can withhold an otherwise valid confirmation candidate",async()=>{
  const request=await resolve("今すぐ開場して");
  const context={evidence,catalog:null,read:async()=>undefined,signal:new AbortController().signal};
  assert.equal((await runPlan(request,context,true)).answers[0].plan.operation,"open");
  assert.equal((await runPlan(request,context,false)).answers[0].plan,undefined);
});

test("a connection recovery question reports a condition without projecting a headcount", async()=>{
  const request=await resolve("入口端末の通信が復旧したら人数はどう変わる？");
  assert.equal(request.plans[0].condition,"connection-restored");
  const source={...evidence,stations:[{role:"in",mode:"live",status:"approved",pending:6}]};
  const result=await runPlan(request,{evidence:source,catalog:null,read:async()=>undefined,
    signal:new AbortController().signal},true);
  assert.match(result.answers[0].text,/未同期 6件/);
  assert.match(result.answers[0].text,/人数への影響は推計できません/);
  assert.equal(result.method,"advanced");
});

test("planner refuses a confirmation proposal merged with other goals", async()=>{
  const action=await resolve("今すぐ開場して");
  const report=await resolve("今何人いる？");
  assert.throws(()=>compilePlan({plans:[...action.plans,...report.plans]}),/Invalid confirmation/);
});
