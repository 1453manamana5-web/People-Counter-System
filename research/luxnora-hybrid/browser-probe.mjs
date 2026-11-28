import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const [entry,executablePath]=process.argv.slice(2);
if(!entry||!executablePath) throw Error("Usage: node browser-probe.mjs PLAYWRIGHT_CORE_ENTRY CHROMIUM");
const {chromium}=await import(pathToFileURL(resolve(entry)));
const assets=new Map();
for(const [name,type] of [["predict.mjs","text/javascript"],["linear-browser.json","application/json"],["structured.json","application/json"]]) {
  assets.set("/"+name,{type,bytes:await readFile(new URL("./"+name,import.meta.url))});
}
const server=createServer((req,res)=>{
  if(req.url==="/") {res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}).end("<p>Luxnora local model benchmark</p>");return;}
  const asset=assets.get(req.url);
  if(!asset) {res.writeHead(404).end();return;}
  res.writeHead(200,{"Content-Type":asset.type}).end(asset.bytes);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser=await chromium.launch({executablePath,args:["--no-sandbox"]});
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto("http://127.0.0.1:"+server.address().port);
  const initial=await page.evaluate(async()=>{
    const start=performance.now();
    const {predict}=await import("/predict.mjs");
    const model=await (await fetch("/linear-browser.json")).json();
    const loadMs=performance.now()-start;
    const corpus=(await (await fetch("/structured.json")).json()).independent;
    globalThis.probe=()=>{
      const times=[],labels=[];
      for(const row of corpus) {
        const started=performance.now();
        labels.push(predict(model,row.text));
        times.push(performance.now()-started);
      }
      times.sort((a,b)=>a-b);
      return {labels,matched:labels.filter((id,i)=>id===corpus[i].capability).length,
        p95Ms:times[Math.ceil(times.length*.95)-1]};
    };
    return {loadMs,online:globalThis.probe()};
  });
  await context.setOffline(true);
  const offline=await page.evaluate(()=>globalThis.probe());
  if(JSON.stringify(initial.online.labels)!==JSON.stringify(offline.labels)) throw Error("Offline inference changed");
  console.log(JSON.stringify({...initial,offline},null,2));
} finally {
  await browser?.close();
  server.close();
}
