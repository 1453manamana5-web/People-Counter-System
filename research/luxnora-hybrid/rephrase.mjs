import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const [file, entry] = process.argv.slice(2);
if (!file || !entry) throw Error("Usage: node rephrase.mjs MODEL.gguf NODE_LLAMA_CPP_ENTRY");
const {getLlama,LlamaChatSession}=await import(pathToFileURL(resolve(entry)));
const cases=JSON.parse(await readFile(new URL("./rephrase-cases.json",import.meta.url),"utf8"));
const llama=await getLlama({gpu:false,logLevel:"error"});
const model=await llama.loadModel({modelPath:resolve(file)});
const context=await model.createContext({contextSize:768,threads:2});
const rows=[];
try {
  for(const item of cases) {
    const sequence=context.getSequence();
    try {
      const session=new LlamaChatSession({contextSequence:sequence,
        systemPrompt:"確認済みの事実だけを使い、質問に自然な日本語で一文で答えてください。数値・状態・対象を変えないでください。"});
      const start=performance.now();
      const output=await session.prompt("質問: "+item.question+"\n確認済みの事実: "+item.verified,{maxTokens:60,temperature:0});
      const normalized=output.normalize("NFKC").replace(/\s/g,"");
      const numbers=[...normalized.matchAll(/\d+(?:\.\d+)?/g)].map(x=>Number(x[0]));
      const unknown=numbers.filter(x=>!item.numbers.includes(x));
      const missing=item.must.filter(x=>!normalized.includes(x));
      rows.push({...item,output,ms:performance.now()-start,unknown,missing,passesCheck:!unknown.length&&!missing.length});
    } finally {sequence.dispose();}
  }
} finally {await context.dispose();await model.dispose();await llama.dispose();}
console.log(JSON.stringify({cases:rows.length,passed:rows.filter(row=>row.passesCheck).length,
  changesNumber:rows.filter(row=>row.unknown.length).length,rows},null,2));
