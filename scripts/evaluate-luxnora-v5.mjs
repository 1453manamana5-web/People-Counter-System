import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {build} from "esbuild";

const dataset=process.argv.includes("--independent")?"independent":process.argv.includes("--validation")?"validation":"goals";
const cases=JSON.parse(await readFile(new URL("../evaluation/v5/"+dataset+".json",import.meta.url),"utf8"));
async function load(root) {
  const {outputFiles:[out]}=await build({stdin:{contents:
    `export {processLuxnoraRequest} from ${JSON.stringify(resolve(root,"management-app/src/luxnora/core.ts"))};`,
    resolveDir:root},bundle:true,write:false,platform:"node",format:"esm"});
  return import("data:text/javascript;base64,"+Buffer.from(out.contents).toString("base64"));
}
async function measure(root, version) {
  const {processLuxnoraRequest}=await load(root);
  const now=Date.parse("2026-11-28T11:00:00+09:00");
  const evidence={scope:"today/live",name:"文化祭",mode:"live",now,current:true,config:null,
    day:{id:"today",eventId:"fair",date:"2026-11-28"},analysis:null,prediction:[],stations:[
      {role:"out",name:"出口端末",mode:"live",status:"approved",lastSeen:now,camera:false,ai:true,pending:0,alert:"camera"},
    ]};
  const failures=[],times=[];
  let unsafe=0;
  for(const {text,expect,target,role,view,noTarget} of cases){
    const snapshot={evidence,catalog:null,view:view??{page:"home",ready:true}};
    const start=performance.now();
    const result=await processLuxnoraRequest({text,profile:"swift",context:{topics:{}},
      signal:new AbortController().signal,observe:()=>snapshot,allowConfirmation:()=>true,
      semantic:async()=>null,read:async()=>undefined});
    times.push(performance.now()-start);
    const actual=result?.answers.map(x=>x.text).join("\n")||result?.request.message||"";
    const options=result?.answers??[];
    const disallowed=!!result?.request.plans.some(x=>x.operation||x.schedule) ||
      options.some(x=>x.plan?.operation||x.plan?.schedule) ||
      options.some(x=>x.target==="new-event"&&!snapshot.view.ready);
    unsafe+=Number(disallowed);
    if(expect.every(item=>actual.includes(item))&&(!target||options.some(x=>x.target===target&&(!role||x.plan?.role===role)))&&
      (!noTarget||options.every(x=>!x.target))&&!disallowed) continue;
    failures.push({text,expect,actual,targets:options.map(x=>x.target),disallowed});
  }
  times.sort((a,b)=>a-b);
  return {version,cases:cases.length,matched:cases.length-failures.length,unsafe,
    p95Ms:times[Math.ceil(times.length*.95)-1],failures};
}
const baseline=process.argv.slice(2).find(value=>!value.startsWith("--"));
if(baseline) console.log(JSON.stringify(await measure(resolve(baseline),"4.1"),null,2));
const result=await measure(process.cwd(),"5");
console.log(JSON.stringify(result,null,2));
if(result.unsafe||result.failures.length) process.exitCode=1;
