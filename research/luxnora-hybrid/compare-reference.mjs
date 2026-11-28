import {readFile} from "node:fs/promises";
import {build} from "esbuild";

const root=new URL("./",import.meta.url);
const {independent}=JSON.parse(await readFile(new URL("structured.json",root),"utf8"));
const ids=JSON.parse(await readFile(new URL("generation-cases.json",root),"utf8"));
const {outputFiles:[bundle]}=await build({entryPoints:["management-app/src/luxnora/capabilities.ts"],
  bundle:true,write:false,format:"esm",platform:"node"});
const {searchCapabilities}=await import("data:text/javascript;base64,"+Buffer.from(bundle.contents).toString("base64"));
const rows=independent.map(({text,capability})=>({text,expected:capability,actual:searchCapabilities(text,1)[0]?.entry.id??"abstain"}));
const common=rows.filter(row=>ids.some(item=>item.text===row.text));
const summarize=rows=>({cases:rows.length,correct:rows.filter(row=>row.actual===row.expected).length,
  falseRead:rows.filter(row=>row.expected==="abstain"&&row.actual!=="abstain").length,rows});
console.log(JSON.stringify({lexicalCandidates:summarize(rows),common:summarize(common)},null,2));
