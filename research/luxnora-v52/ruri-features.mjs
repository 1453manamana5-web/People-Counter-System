import {createServer} from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const [entry, executablePath, assets, data, output] = process.argv.slice(2);
if (!output) throw Error("Usage: node ruri-features.mjs PLAYWRIGHT_CORE_ENTRY CHROMIUM ASSETS DATA OUTPUT");
const {chromium} = await import(pathToFileURL(resolve(entry)));
const texts = new Set();
for (const split of ["train", "validation", "independent", "conversation"]) {
  const rows = (await readFile(resolve(data, split + ".jsonl"), "utf8")).trimEnd().split("\n");
  for (const row of rows) texts.add(JSON.parse(row).text);
}
const staticFiles = [
  "transformers.min.js", "wasm/ort-wasm-simd-threaded.jsep.mjs", "wasm/ort-wasm-simd-threaded.jsep.wasm",
  ...["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json", "config.json", "special_tokens_map.json"]
    .map(name => "ruri-v3-30m/" + name),
];
const sizes = {};
const server = createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(200, {"Content-Type": "text/html"}).end("<title>Ruri feature comparison</title>");
    return;
  }
  const name = request.url.slice(1);
  if (!staticFiles.includes(name)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(resolve(assets, name));
    sizes[name] = bytes.length;
    const type = name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "text/javascript";
    response.writeHead(200, {"Content-Type": type}).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({executablePath, args: ["--no-sandbox"]});
  const page = await browser.newPage();
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto("http://127.0.0.1:" + server.address().port);
  const computed = await page.evaluate(async texts => {
    const start = performance.now();
    const {env, pipeline} = await import("/transformers.min.js");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = location.origin + "/";
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.wasmPaths = location.origin + "/wasm/";
    const extract = await pipeline("feature-extraction", "ruri-v3-30m", {device: "wasm", dtype: "q8"});
    const loadMs = performance.now() - start;
    const all = performance.now();
    const vectors = [];
    texts.sort((a, b) => a.length - b.length);
    for (let offset = 0; offset < texts.length; offset += 12) {
      const batch = texts.slice(offset, offset + 12);
      const output = await extract(batch.map(value => "トピック: " + value), {pooling: "mean", normalize: true});
      vectors.push(...output.tolist());
    }
    return {loadMs, extractMs: performance.now() - all, texts, vectors};
  }, [...texts]);
  await writeFile(output, JSON.stringify({...computed, sizes}) + "\n");
  console.log(JSON.stringify({loadMs: computed.loadMs, extractMs: computed.extractMs, texts: computed.texts.length, sizes}));
} finally {
  await browser?.close();
  server.close();
}
