import {createServer} from "node:http";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {bundle} from "./evaluate.mjs";
import {fixture} from "./scenarios.mjs";

const [path,executablePath]=process.argv.slice(2);
const {chromium}=await import(pathToFileURL(resolve(path)));
const script=await bundle(process.cwd(),true);
const worker=`
self.addEventListener("install",event=>event.waitUntil(caches.open("lux-v6-fixture").then(cache=>cache.addAll(["/","/core.js"])).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>event.respondWith(caches.match(event.request).then(response=>response||fetch(event.request))));
`;
const server=createServer((req,res)=>{
  const files={"/":["text/html","<!doctype html><title>Luxnora offline fixture</title>"],
    "/core.js":["text/javascript",script],"/sw.js":["text/javascript",worker]};
  if(!Object.hasOwn(files,req.url)) {res.writeHead(404).end();return;}
  const [type,body]=files[req.url];
  res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"}).end(body);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser=await chromium.launch({executablePath,args:["--no-sandbox"]});
  const context=await browser.newContext();
  const url="http://127.0.0.1:"+server.address().port;
  const page=await context.newPage();
  await page.goto(url);
  async function run(page) {
    return page.evaluate(async envelope=>{
      const boot=performance.now();
      const {processLuxnoraRequest}=await import("/core.js");
      const loadMs=performance.now()-boot;
      const durations={simple:[],compound:[]};
      const outputs={};
      let historical=0;
      for(const [name,text] of [
        ["simple","出口の未同期件数を教えて"],
        ["compound","今年の入場回数が去年より少ない理由を調べて。出口の未同期件数を教えて"],
      ]) {
        for(let i=0;i<40;i++) {
          const now=performance.now();
          const result=await processLuxnoraRequest({text,profile:"auto",context:{topics:{}},
            signal:new AbortController().signal,observe:()=>envelope,semantic:async()=>null,
            allowConfirmation:()=>false,read:async()=>{historical++;return undefined;}});
          durations[name].push(performance.now()-now);
          outputs[name]=result.answers.map(answer=>answer.text);
        }
      }
      const p95=Object.fromEntries(Object.entries(durations).map(([key,items])=>[key,items.sort((a,b)=>a-b)[37]]));
      return {loadMs,p95,outputs,historical};
    },fixture("history-failure").snapshot);
  }
  const online=await run(page);
  await page.evaluate(async()=>{
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.close();
  await context.setOffline(true);
  const reopened=await context.newPage();
  await reopened.goto(url);
  const offline=await run(reopened);
  if(JSON.stringify(online.outputs)!==JSON.stringify(offline.outputs)||
    !offline.outputs.simple[0].includes("未同期は 4件")||!offline.outputs.compound[0].includes("入場 1回"))
    throw Error("Offline fixture did not preserve verified partial responses");
  console.log(JSON.stringify({browser:browser.version(),sameOutputs:true,online,offline},null,2));
} finally {
  await browser?.close();
  server.close();
}
