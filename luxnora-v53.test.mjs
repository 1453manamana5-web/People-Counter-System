import assert from "node:assert/strict";
import test from "node:test";
import {loadCore,request,snapshot} from "./research/luxnora-v53/prepare.mjs";

const api=await loadCore();
const now=Date.now();
const blank=()=>({scope:snapshot.evidence.scope,topics:{}});
async function turns(...messages) {
  let state=blank(),result;
  for(const text of messages) {
    result=await request(api,text,state);
    state=api.rememberOutcomes(result.request,state,Date.now(),result.answers);
  }
  return {state,result};
}

test("comparison corrections preserve metric, independent station and prior period",async()=>{
  const {state,result}=await turns("今年と去年の入場回数を午前で比較して","出口端末の状態を確認して",
    "比較の方を午後に修正して","元の条件に戻して");
  assert.equal(result.request.plans[0].period,"am");
  assert.equal(result.request.plans[0].comparisonMetric,"entries");
  assert.equal(state.topics.station.plans[0].role,"out");
  assert.equal(state.outcomes.comparison.state,"partial");
});

test("read-only revisions expire and cannot reuse a different event or old operation",async()=>{
  const {state}=await turns("今日の入場回数を教えて");
  assert.equal(api.activeTopics(state,now+301_000).length,0);
  assert.deepEqual(api.scopedContext(state,"another/test").topics,{});
  const next=await request(api,"同じ条件でもう一度確認して",{...blank(),topics:state.topics,scope:"another/test"});
  assert.deepEqual(next.request.plans,[]);
  const mixed=await request(api,"閉場して。出口端末の状態を確認して",state);
  assert.equal(mixed.request.plans.some(plan=>plan.operation),false);
});

test("ambiguous references in Core can be previewed without editing the reply or calling live readers",async()=>{
  const {state}=await turns("今日の入場回数を教えて。入口端末の状態を確認して");
  let preview,reads=0;
  const result=await api.processLuxnoraRequest({text:"同じ条件でもう一度確認して",context:state,
    profile:"auto",signal:new AbortController().signal,observe:()=>snapshot,
    read:async()=>{reads++;},semantic:async()=>null,allowConfirmation:()=>true,
    shadow:{predict:async()=> "station",report:value=>{preview=value;}},
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,0);
  assert.deepEqual(result.request.plans,[]);
  assert.equal(preview.candidate.plans[0].intent,"stations");
  assert.equal(preview.candidate.plans[0].focus,false);
  assert.equal(preview.candidate.plans[0].readOnly,true);
  assert.ok(preview.capabilities.includes("stations"));
});

test("guidance combines with read goals and typed planner rejects a forged registry binding",async()=>{
  const result=await request(api,"今の会場内の人数を確認して。それからオフライン運用はどうすればいい？",blank());
  assert.deepEqual(result.request.plans.map(plan=>plan.guidanceId??plan.intent),["occupancy","station.offline"]);
  assert.equal(result.answers.at(-1).target,undefined);
  for(const guidanceId of ["unknown","station.pair"]) {
    assert.throws(()=>api.compilePlan({plans:[{intent:"briefing",guidanceId,focus:false,readOnly:false}]}),
      /Invalid guidance goal/);
  }
});

test("shadow load failures and unrecognized outputs leave the read-only response unchanged",async()=>{
  const {state}=await turns("今日の退場回数を教えて");
  const message="同じ条件でもう一度確認して";
  const expected=await request(api,message,state);
  for(const predict of [async()=>{throw Error("worker unavailable");},async()=>({operation:"close"})]) {
    let called=false;
    const observed=await request(api,message,state,{predict,report:()=>{called=true;}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(observed,expected);
    assert.equal(called,false);
  }
});
