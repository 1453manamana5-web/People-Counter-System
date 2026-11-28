import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {labelOf,loadCore,request,snapshot} from "./prepare.mjs";
import {classify} from "./inference.mjs";

const [data,artifacts,oldRoot]=process.argv.slice(2);
if(!oldRoot) throw Error("Usage: node evaluate.mjs DATA ARTIFACTS V52_WORKTREE");
const holdout=(await readFile(resolve(data,"independent.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
const regression=JSON.parse(await readFile(new URL("./task-suite.json",import.meta.url),"utf8"));
const independent=JSON.parse(await readFile(new URL("./unseen-suite.json",import.meta.url),"utf8"));
const current=await loadCore();
const old=await loadCore(oldRoot);
const semantic=JSON.parse(await readFile(resolve(data,"ruri.json"),"utf8"));
const embeddings=new Map(semantic.texts.map((text,i)=>[text,semantic.vectors[i]]));
const stateModel=JSON.parse(await readFile(resolve(artifacts,"state.json"),"utf8"));
const ruriModel=JSON.parse(await readFile(resolve(artifacts,"ruri.json"),"utf8"));

function update(api,result,state) {
  return (api.rememberOutcomes??api.rememberTopics)(result.request,state,Date.now(),result.answers);
}
function intent(plan) {
  return plan.guidanceId?"guide:"+plan.guidanceId:plan.intent+(plan.period&&typeof plan.period==="string"?":"+plan.period:"")+
    (plan.role?":"+plan.role:"");
}
function isOperation(result) {
  return [...result.request.plans,...result.answers.map(item=>item.plan).filter(Boolean)]
    .some(plan=>plan.operation||plan.schedule||plan.intent==="routine"&&!plan.readOnly);
}

async function conversations(api,model) {
  let correct=0,all=0,invalid=0,total=0,turns=0,covered=0,shadowCorrect=0,isolated=0,usable=0,changed=0;
  for(const row of holdout) {
    let context={scope:snapshot.evidence.scope,topics:{}};
    let last,preview,goodHistory=true;
    for(const [i,text] of row.turns.entries()) {
      const final=i===row.turns.length-1;
      last=await request(api,text,context,model&&final?{
        predict:async state=>classify(model,state,embeddings.get(state.text)),
        report:result=>{preview=result;},
      }:undefined);
      if(final) await new Promise(resolve=>setImmediate(resolve));
      const actual=labelOf(last);
      // Explicit starts should establish a usable topic. A lost start is
      // charged to the dialogue before scoring the final reference.
      if(i<2&&row.structure!=="ambiguous" && row.structure!=="focus" && actual==="clarify") goodHistory=false;
      if(i===0 && actual==="clarify") goodHistory=false;
      invalid+=+isOperation(last);
      turns++;
      context=update(api,last,context);
    }
    total++;
    correct+=+(labelOf(last)===row.expected);
    all+=+(goodHistory&&labelOf(last)===row.expected);
    if(preview) {
      covered++;
      const candidate=labelOf({request:preview.candidate});
      changed+=+(candidate!==labelOf(last));
      shadowCorrect+=+(candidate===row.expected);
      // Stage 1: execute the compiled candidate with real Planner/Guard
      // semantics using only fixture evidence and a stub historical reader.
      const run=await api.runPlan(preview.candidate,{...snapshot,signal:new AbortController().signal,
        read:async()=>undefined},false);
      isolated+=run.answers.length;
      usable+=run.answers.filter(answer=>answer.source||answer.diagnosticSignal!==undefined||
        answer.comparisonDelta!==undefined).length;
      invalid+=+isOperation({request:preview.candidate,answers:run.answers});
    }
  }
  return {total,turns,correct,startsAndFinal:all,invalid,shadow:{covered,changed,correct:shadowCorrect,
    executedFixtureAnswers:isolated,answersWithSourceOrVerification:usable}};
}

async function tasks(api,suite) {
  const groups={},failures=[];
  for(const row of suite) {
    const stats=groups[row.group]??={turns:0,correct:0,conversations:0,complete:0,unsafe:0};
    let context={scope:snapshot.evidence.scope,topics:{}};
    let all=true;
    for(const [text,expected,fragments] of row.turns) {
      const final=await request(api,text,context);
      context=update(api,final,context);
      const got=final.request.plans.map(intent);
      const answer=final.answers.map(x=>x.text).join("\n")||final.request.message||"";
      const unsafe=isOperation(final);
      const ok=!unsafe&&JSON.stringify(got)===JSON.stringify(expected)&&fragments.every(fragment=>answer.includes(fragment));
      stats.turns++;
      stats.correct+=+ok;
      stats.unsafe+=+unsafe;
      all&&=ok;
      if(!ok) failures.push({group:row.group,text,expected,got,answer,unsafe});
    }
    stats.conversations++;
    stats.complete+=+all;
  }
  return {groups,failures};
}

const result={v52:{dialogues:await conversations(old),tasks:await tasks(old,independent),regression:await tasks(old,regression)},
  v53:{dialogues:await conversations(current),tasks:await tasks(current,independent),regression:await tasks(current,regression),
    shadowState:await conversations(current,stateModel),shadowRuri:await conversations(current,ruriModel)}};
await writeFile(resolve(artifacts,"integration.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result,null,2));
if(result.v53.dialogues.invalid||result.v53.shadowRuri.invalid||Object.values(result.v53.tasks.groups).some(row=>row.unsafe))
  process.exitCode=1;
