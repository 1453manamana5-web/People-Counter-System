import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";

const [repository,esbuildPath,ref="2f05379",destination="artifacts/knowledge.json"]=process.argv.slice(2);
const {transform}=await import(pathToFileURL(resolve(esbuildPath)));
const revision=execFileSync("git",["rev-parse",ref],{cwd:repository,encoding:"utf8"}).trim();
const sources={};
function source(path) {
  const raw=execFileSync("git",["show",revision+":"+path],{cwd:repository,encoding:"utf8"});
  sources[path]=createHash("sha256").update(raw).digest("hex");
  return raw;
}
async function moduleOf(path) {
  const code=source(path);
  const compiled=path.endsWith(".ts")?(await transform(code,{loader:"ts",format:"esm"})).code:code;
  return import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
}
const management="management-app/src/";
const reception="counter-app/public/people-counter/";
const {capabilities}=await moduleOf(management+"luxnora/capabilities.ts");
const lifecycle=await moduleOf(management+"counterLifecycle.ts");
const station=await moduleOf(reception+"station-command.mjs");
const recovery=await moduleOf(reception+"luxnora-core.mjs");
const stages=Object.keys(lifecycle.stageLabels);
const lifecycleGuards=Object.fromEntries(stages.map(stage=>[stage,lifecycle.actionsFor({...lifecycle.emptyDay,stage})]));
const schemas={};
for(const file of [management+"counterAuth.ts",management+"counterEvents.ts",management+"counterManagementData.ts",
  management+"counterComparisonMetrics.ts","counter-app/src/counterSync.ts"]) {
  const code=source(file);
  schemas[file]=[...code.matchAll(/(?:export )?type ([A-Za-z]+)\s*=/g)].map(match=>match[1]);
}
for(const name of ["ledger.mjs","records.mjs","health.mjs","counter-offline.js","app.js","connection.mjs","vision.mjs"]) source(reception+name);
const controls=[];
for(const verified of [false,true]) for(const visible of [false,true]) for(const tracking of [0,1])
  for(const attempts of [0,1]) for(const enabled of [false,true]) {
    const input={verified,visible,tracking,attempts,enabled};
    controls.push({input,accepted:recovery.recoveryDecision(input)});
  }
const relations=[
  {id:"sync.order",inputs:["local-ledger","event-day","mode"],steps:["record","persist","pending","upload","receipt"],checks:["mode","event-day","operation-id"],source:reception+"ledger.mjs"},
  {id:"station.recovery",inputs:["device","role","mode","configVersion","assignment"],checks:["approval","visibility","tracking","budget","new-inference"],source:reception+"station-command.mjs"},
  {id:"analytics",inputs:["event-day","mode","reconciled-ledger"],checks:["consistency","freshness"],source:management+"luxnora/capabilities.ts"},
];
await writeFile(destination,JSON.stringify({schema:1,revision,sources,schemas,capabilities,lifecycleGuards,
  stationActions:station.stationActions,stationResults:station.stationResults,controls,relations},null,2)+"\n");
