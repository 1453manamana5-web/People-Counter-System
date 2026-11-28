import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const [entry,binary,assets,directory]=process.argv.slice(2);
if(!directory) throw Error("Usage: node browser-probe.mjs PLAYWRIGHT_ENTRY CHROMIUM LUXNORA_ASSETS ARTIFACTS");
const {chromium}=await import(pathToFileURL(resolve(entry)));
const research=["inference.mjs","model.worker.mjs","browser-client.mjs","browser-reference.json","ruri.json","state.json"];
const existing=[
  "transformers.min.js","wasm/ort-wasm-simd-threaded.jsep.mjs","wasm/ort-wasm-simd-threaded.jsep.wasm",
  ...["onnx/model_quantized.onnx","tokenizer.json","tokenizer_config.json","config.json","special_tokens_map.json"]
    .map(file=>"ruri-v3-30m/"+file)
];
const cachePaths=["/",...research.map(name=>"/"+name),...existing.map(name=>"/luxnora-assets/"+name)];
const server=createServer(async(req,res)=>{
  const url=req.url;
  if(url==="/") {res.writeHead(200,{"Content-Type":"text/html","Cache-Control":"no-store"}).end("<title>Luxnora context benchmark</title>");return;}
  if(url==="/sw.js") {
    res.writeHead(200,{"Content-Type":"text/javascript"}).end(`
      self.addEventListener("install",e=>e.waitUntil(caches.open("v53-offline").then(c=>c.addAll(${JSON.stringify(cachePaths)})).then(()=>self.skipWaiting())));
      self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
      self.addEventListener("fetch",e=>e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request))));
    `);
    return;
  }
  if(!cachePaths.includes(url)) {res.writeHead(404).end();return;}
  try {
    const name=url.slice(1);
    const file=name.startsWith("luxnora-assets/")?resolve(assets,name.slice("luxnora-assets/".length)):
      name.endsWith(".json")?resolve(directory,name):new URL("./"+name,import.meta.url);
    const type=name.endsWith(".wasm")?"application/wasm":name.endsWith(".json")?"application/json":
      name.endsWith(".onnx")?"application/octet-stream":"text/javascript";
    res.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store"}).end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));

async function measure(page) {
  return page.evaluate(async()=>{
    const expected=await (await fetch("/browser-reference.json")).json();
    const {createBrowserReference}=await import("/browser-client.mjs");
    const client=createBrowserReference();
    const results={};
    for(const mode of ["state","ruri"]) {
      const rows=expected[mode];
      let begin=performance.now();
      const initial=await client.predict(mode,rows.slice(0,1));
      const firstMs=performance.now()-begin;
      begin=performance.now();
      const bulk=await client.predict(mode,rows);
      const batchMs=performance.now()-begin;
      const times=[];
      for(let i=0;i<20;i++) {
        const start=performance.now();
        await client.predict(mode,rows.slice(i,i+1));
        times.push(performance.now()-start);
      }
      times.sort((a,b)=>a-b);
      results[mode]={firstMs,batchMs,warmP95Ms:times[18],cases:rows.length,
        matches:bulk?.filter((value,i)=>value===rows[i].prediction).length??0,firstMatched:initial?.[0]===rows[0].prediction};
    }
    const controller=new AbortController();
    const pending=client.predict("ruri",expected.ruri,controller.signal);
    controller.abort();
    const cancelled=await pending===null;
    const restarts=(await client.predict("state",expected.state.slice(0,1)))?.length===1;
    client.release();
    return {results,cancelled,restarts};
  });
}

let browser;
try {
  const url="http://127.0.0.1:"+server.address().port;
  browser=await chromium.launch({executablePath:binary,args:["--no-sandbox"]});
  const ctx=await browser.newContext();
  const page=await ctx.newPage();
  await page.goto(url);
  const online=await measure(page);
  await page.evaluate(async()=>{await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;});
  await page.close();
  await ctx.setOffline(true);
  const reopened=await ctx.newPage();
  await reopened.goto(url);
  const offline=await measure(reopened);
  for(const test of [online,offline]) {
    if(!test.cancelled||!test.restarts||Object.values(test.results).some(x=>x.matches!==x.cases||!x.firstMatched))
      throw Error(JSON.stringify(test));
  }
  console.log(JSON.stringify({chromium:browser.version(),online,offline},null,2));
} finally {
  await browser?.close();
  server.close();
}
