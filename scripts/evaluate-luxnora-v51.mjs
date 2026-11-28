import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {build} from "esbuild";

const dataset=process.argv.includes("--independent")?"independent":"workflows";
const cases=JSON.parse(await readFile(new URL("../evaluation/v5-1/"+dataset+".json",import.meta.url),"utf8"));
const now=Date.parse("2026-11-28T11:00:00+09:00");
const evidence={scope:"day/live",mode:"live",now,name:"文化祭",current:true,config:null,
  day:{id:"day",eventId:"fair",date:"2026-11-28"},analysis:null,prediction:[],stations:[
    {role:"out",name:"出口端末",mode:"live",status:"approved",lastSeen:now,camera:false,ai:true,pending:4,alert:"camera"},
  ]};
async function evaluate(root, version) {
  const app=file=>JSON.stringify(resolve(root,"management-app/src/luxnora",file+".ts"));
  const {outputFiles:[bundle]}=await build({stdin:{contents:
    `export * from ${app("core")}; export * from ${app("context")};`,resolveDir:root},
    bundle:true,write:false,platform:"node",format:"esm"});
  const {processLuxnoraRequest,rememberTopics}=await import("data:text/javascript;base64,"+Buffer.from(bundle.contents).toString("base64"));
  const failures=[],elapsed=[];
  let unsafe=0,turns=0;
  for(const row of cases) {
    const snapshot={evidence:{...evidence,...row.evidence},catalog:null,view:{page:"home",ready:true}};
    let context={scope:snapshot.evidence.scope,topics:{}};
    for(const item of row.turns??[row]) {
      const start=performance.now();
      const result=await processLuxnoraRequest({text:item.text,profile:"swift",context,observe:()=>snapshot,
        signal:new AbortController().signal,allowConfirmation:()=>true,semantic:async()=>null,read:async()=>undefined});
      elapsed.push(performance.now()-start);
      turns++;
      context=rememberTopics(result.request,context,Date.now());
      const text=result.answers.map(x=>x.text).join("\n")||result.request.message||"";
      const plans=result.request.plans.map(x=>x.intent+(x.role?":"+x.role:""));
      const invalid=result.request.plans.some(x=>x.operation||x.schedule)||result.answers.some(x=>x.plan?.operation||x.plan?.schedule);
      unsafe+=Number(invalid);
      if(invalid||JSON.stringify(plans)!==JSON.stringify(item.goals)||!item.expects.every(s=>text.includes(s))||
         (item.omits??[]).some(s=>text.includes(s))) failures.push({text:item.text,expected:item.expects,plans,actual:text});
    }
  }
  elapsed.sort((a,b)=>a-b);
  return {version,scenarios:cases.length,turns,passed:turns-failures.length,unsafe,
    p95Ms:elapsed[Math.ceil(elapsed.length*.95)-1],failures};
}
const baseline=process.argv.slice(2).find(x=>!x.startsWith("--"));
if(baseline) console.log(JSON.stringify(await evaluate(resolve(baseline),"5.0"),null,2));
const result=await evaluate(process.cwd(),"5.1");
console.log(JSON.stringify(result,null,2));
if(result.unsafe || dataset==="workflows"&&result.passed!==result.turns) process.exitCode=1;
