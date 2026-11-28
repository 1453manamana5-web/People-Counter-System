import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {buildDialogues,intentTopic} from "./dialogues.mjs";

export const snapshot={evidence:{scope:"fair/live",mode:"live",now:Date.now(),name:"文化祭",
  current:true,config:null,day:{id:"current",eventId:"fair",date:"2026-11-28"},analysis:null,prediction:[],
  stations:[{role:"out",name:"出口端末",mode:"live",status:"approved",lastSeen:Date.now(),camera:false,ai:true,pending:4,alert:"camera"}]},
  catalog:null,view:{page:"home",ready:true}};

export async function loadCore(root=process.cwd()) {
  const app=file=>JSON.stringify(resolve(root,"management-app/src/luxnora",file+".ts"));
  const {outputFiles:[bundle]}=await build({stdin:{contents:
    `export * from ${app("core")}; export * from ${app("context")}; export * from ${app("planner")};
      export * from ${app("capabilities")};`,resolveDir:root},bundle:true,write:false,platform:"node",format:"esm"});
  return import("data:text/javascript;base64,"+Buffer.from(bundle.contents).toString("base64"));
}

export async function request(api,text,context,shadow) {
  return api.processLuxnoraRequest({text,context,shadow,profile:"swift",observe:()=>snapshot,
    signal:new AbortController().signal,allowConfirmation:()=>false,semantic:async()=>null,read:async()=>undefined});
}

export const labelOf=result=>result?.request.plans.length===1 ?
  (intentTopic[result.request.plans[0].intent]??"clarify") : "clarify";

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const out=resolve(process.argv[2]);
  await mkdir(out,{recursive:true});
  const api=await loadCore();
  const splits={},seen=new Set();
  for(const [split,count] of [["train",1000],["validation",200],["independent",300]]) {
    const data=buildDialogues(split,count);
    let baseline=0;
    for(const item of data) {
      const key=JSON.stringify(item.turns);
      if(seen.has(key)) throw Error("Dialogue overlaps partitions");
      seen.add(key);
      let state={scope:snapshot.evidence.scope,topics:{}};
      const trace=[];
      for(const text of item.turns.slice(0,-1)) {
        const value=await request(api,text,state);
        trace.push(labelOf(value));
        state=api.rememberOutcomes(value.request,state,Date.now(),value.answers);
      }
      const text=item.turns.at(-1);
      const current=await request(api,text,state);
      item.text=text;
      item.inferred={active:state.active??null,topics:api.activeTopics(state,Date.now()),trace};
      item.baseline=labelOf(current);
      baseline+=+(item.baseline===item.expected);
    }
    splits[split]={conversations:data.length,turns:data.reduce((n,x)=>n+x.turns.length,0),
      structures:[...new Set(data.map(row=>row.structure))],
      distinctCurrent:new Set(data.map(row=>row.text)).size,distinctUtterances:new Set(data.flatMap(row=>row.turns)).size,
      baseline};
    await writeFile(resolve(out,split+".jsonl"),data.map(row=>JSON.stringify(row)).join("\n")+"\n");
  }
  await writeFile(resolve(out,"quality.json"),JSON.stringify(splits,null,2)+"\n");
  console.log(splits);
}
