import {readFile,stat} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const [modelFile,modulePath,mode,casesPath]=process.argv.slice(2);
if(!modelFile||!modulePath) throw Error("Usage: node evaluate-gguf.mjs MODEL.gguf NODE_LLAMA_CPP_ENTRY [grammar] [CASES.json]");
const {getLlama,LlamaChatSession}=await import(pathToFileURL(resolve(modulePath)));
const data=JSON.parse(await readFile(casesPath??new URL("./generation-cases.json",import.meta.url),"utf8"));
const started=performance.now();
const llama=await getLlama({gpu:false,logLevel:"error"});
const model=await llama.loadModel({modelPath:resolve(modelFile)});
const context=await model.createContext({contextSize:768,threads:2});
const loadMs=performance.now()-started;
const ids=["station.pair","station.offline","mode","event.create","station.health","abstain"];
const grammar=mode==="grammar"?await llama.createGrammarForJsonSchema({
  type:"object",properties:{id:{enum:ids}},required:["id"],additionalProperties:false,
}):undefined;
const rows=[];
const system="You are a Japanese visitor counter capability selector. Output only JSON with one field id. Allowed IDs: station.pair (pair terminal), station.offline (connection interrupted), mode (test versus live), event.create (creation instructions), station.health (inspect device), abstain (outside scope, negative or state changes). Never execute actions.";
try {
  for(const item of data) {
    const sequence=context.getSequence();
    try {
      const chat=new LlamaChatSession({contextSequence:sequence,systemPrompt:system});
      const start=performance.now();
      const raw=await chat.prompt(item.text,{maxTokens:40,temperature:0,grammar});
      const elapsedMs=performance.now()-start;
      let parsed;
      try{parsed=JSON.parse(raw);}catch{}
      const valid=!!parsed&&typeof parsed==="object"&&!Array.isArray(parsed)&&Object.keys(parsed).length===1&&
        ids.includes(parsed.id);
      rows.push({...item,raw,valid,elapsedMs,matched:valid&&parsed.id===item.id});
    } finally {sequence.dispose();}
  }
  console.log(JSON.stringify({bytes:(await stat(modelFile)).size,mode:mode??"raw",loadMs,peakRssKiB:process.resourceUsage().maxRSS,
    valid:rows.filter(x=>x.valid).length,matched:rows.filter(x=>x.matched).length,rows},null,2));
} finally {await context.dispose();await model.dispose();await llama.dispose();}
