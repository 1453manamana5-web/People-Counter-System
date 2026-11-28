import test from "node:test";
import assert from "node:assert/strict";
import {bundle} from "./research/luxnora-v6/evaluate.mjs";
import {fixture} from "./research/luxnora-v6/scenarios.mjs";

const app=await import("data:text/javascript;base64,"+Buffer.from(await bundle()).toString("base64"));
function query(text,env,overrides={}) {
  return app.processLuxnoraRequest({text,context:{topics:{}},profile:"swift",
    signal:new AbortController().signal,observe:()=>env.snapshot,semantic:async()=>null,
    read:async()=>env.history,allowConfirmation:()=>false,...overrides});
}

test("required station count wins over alerts, and cached counts are qualified",async()=>{
  for(const kind of ["current","stale","malformed","missing","test"]) {
    const env=fixture(kind);
    const response=(await query("出口端末の未同期件数を確認して",env)).answers[0];
    assert.equal(response.objective.result,"pending-records");
    if(["malformed","missing"].includes(kind)) {
      assert.equal(response.objective.status,"missing");
      assert.equal(response.objective.reported.length,0);
      assert.match(response.text,/件数は確認できません/);
    } else {
      assert.deepEqual(response.objective.reported.map(x=>x.count),[4]);
      assert.match(response.text.split("\n")[0],/未同期は 4件/);
      assert.doesNotMatch(response.text,/999/);
      if(kind==="stale") assert.match(response.text,/現在の件数は未確認/);
      else assert.match(response.text,/カメラ異常/);
    }
  }
});

test("comparison fallback preserves available current count without inventing a difference",async()=>{
  const result=await query("今年の入場回数が去年より少ない理由を調べて",fixture("history-failure"));
  const answer=result.answers[0];
  assert.match(answer.text,/入場 1回/);
  assert.match(answer.text,/差の原因は判断できません/);
  assert.equal(answer.comparisonDelta,undefined);
  assert.deepEqual(answer.objective.missing,["verified-comparison","causal-evidence"]);
});

test("conditional inputs run only when a comparison establishes the trigger",async()=>{
  const context=env=>({...env.snapshot,read:async()=>env.history,signal:new AbortController().signal});
  const request={plans:[
    {intent:"compare",previousYear:true,compareDifference:true,readOnly:true,focus:false},
    {intent:"issues",readOnly:true,focus:false},
  ],dependencies:[{task:1,after:0,when:"previous-year-lower"}]};
  const missing=await app.runPlan(request,context(fixture("history-failure")),false);
  assert.equal(missing.trace.some(step=>step.capability==="stations"),false);
  assert.match(missing.answers[1].text,/保留/);
  const valid=await app.runPlan(request,context(fixture("current")),false);
  assert.equal(valid.answers[0].comparisonDelta,-7);
  assert.equal(valid.trace.some(step=>step.capability==="stations"),true);
});

test("a loss of access prevents pending facts, historical reads, and confirmation",async()=>{
  const env=fixture("forbidden");
  for(const text of ["今年と去年の入場を比較して","出口の未同期件数を教えて","今すぐ閉場して"]) {
    const got=await query(text,env,{read:async()=>assert.fail("forbidden read"),allowConfirmation:()=>true});
    assert.match(got.answers[0].text,/閲覧権限/);
    assert.deepEqual(got.request.plans,[]);
  }
});

test("a forged deliverable cannot be combined with a confirmation",()=>{
  assert.throws(()=>app.compilePlan({plans:[{intent:"event",operation:"close",
    deliverable:"pending-records",focus:true,readOnly:false}]}),/Invalid deliverable/);
});
