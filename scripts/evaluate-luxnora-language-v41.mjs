import {build} from "esbuild";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

const dataset=process.argv.includes("--independent")?"independent":"development";
const examples=JSON.parse(await readFile(new URL("../evaluation/v4-1/"+dataset+".json",import.meta.url),"utf8"));
async function evaluate(root,current) {
  const source=file=>JSON.stringify(resolve(root,"management-app/src/luxnora",file+".ts"));
  const {outputFiles:[output]}=await build({stdin:{contents:
    `export * from ${source("runtime")}; export * from ${source("context")};`+
      (current?`export {resolveLanguage} from ${source("understanding")};`:""),resolveDir:root},
    bundle:true,write:false,platform:"node",format:"esm"});
  const api=await import("data:text/javascript;base64,"+Buffer.from(output.contents).toString("base64"));
  const tracks={},failures=[],times=[];
  let intents=0, slots=0, turnCount=0, conversations=0, unsafe=0, modelCalls=0;
  const now=1_800_000_000_000;
  const model=async()=>{modelCalls++;return null;};
  for(const {track,turns} of examples) {
    let context={topics:{}};
    let passed=true;
    for(const [text,wanted,key,restricted] of turns) {
      const started=performance.now();
      const result=current?await api.resolveLanguage(text,context,now,"auto",model):
        api.recallCorrection(text,context,now)??await api.resolveRequest(text,context.focus,now,"auto",model);
      times.push(performance.now()-started);
      context=api.rememberTopics(result,context,now);
      const plans=result.plans.map(p=>[p.intent,p.role,typeof p.period==="object"?JSON.stringify(p.period):p.period,
        p.comparisonMetric,p.horizon].filter(value=>value!==undefined).join(":"));
      const condition=result.reset?"reset":result.dependencies?.length?result.dependencies.map(dep=>dep.after+">"+dep.task+":"+dep.when).join(","):undefined;
      const approval=result.plans.some(p=>p.operation||p.schedule);
      const actualIntents=plans.map(p=>p.split(":")[0]);
      if(JSON.stringify(actualIntents)===JSON.stringify(wanted.map(p=>p.split(":")[0]))) intents++;
      if(JSON.stringify(plans)===JSON.stringify(wanted)) slots++;
      const correct=JSON.stringify(plans)===JSON.stringify(wanted)&&condition===(key??undefined)&&(!restricted||result.constraints?.readOnly===true)&&!approval;
      if(approval) unsafe++;
      turnCount++;
      const stat=tracks[track]??={cases:0,matched:0};
      stat.cases++;
      if(correct) stat.matched++;
      else {
        passed=false;
        failures.push({track,text,wanted,key,plans,condition,approval});
      }
    }
    conversations+=Number(passed);
  }
  times.sort((a,b)=>a-b);
  return {version:current?"4.1":"4.0",turnCount,matched:turnCount-failures.length,intents,slots,
    conversations,totalConversations:examples.length,unsafe,modelCalls,p95Ms:times[Math.ceil(times.length*.95)-1],tracks,failures};
}
const baseline=process.argv.slice(2).find(arg=>!arg.startsWith("--"));
if(baseline) console.log(JSON.stringify(await evaluate(resolve(baseline),false),null,2));
if(!process.argv.includes("--baseline-only")){
  const result=await evaluate(process.cwd(),true);
  console.log(JSON.stringify(result,null,2));
  if(result.unsafe||result.matched!==result.turnCount) process.exitCode=1;
}
