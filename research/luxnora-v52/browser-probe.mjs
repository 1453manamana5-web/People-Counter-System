import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {gzipSync} from "node:zlib";

const [entry, executablePath, directory = "artifacts"] = process.argv.slice(2);
if (!entry || !executablePath) throw Error("Usage: node browser-probe.mjs PLAYWRIGHT_CORE_ENTRY CHROMIUM [ARTIFACTS]");
const {chromium} = await import(pathToFileURL(resolve(entry)));
const names = ["browser-int8.json", "browser-float.json", "browser-reference.json"];
const assets = new Map([
  ["/", ["text/html; charset=utf-8", "<title>Luxnora Ver.5.2 benchmark</title>"]],
  ["/predict.mjs", ["text/javascript", await readFile(new URL("./predict.mjs", import.meta.url))]],
  ...await Promise.all(names.map(async name => ["/" + name, ["application/json", await readFile(resolve(directory, name))]])),
]);
assets.set("/worker.js", ["text/javascript", `
  self.addEventListener("install", event => event.waitUntil(
    caches.open("luxnora-v52-test").then(cache => cache.addAll(${JSON.stringify([...assets.keys()])}))
      .then(() => self.skipWaiting())));
  self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", event => event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))));
`]);

const server = createServer((request, response) => {
  const asset = assets.get(request.url);
  if (!asset) { response.writeHead(404).end(); return; }
  response.writeHead(200, {"Content-Type": asset[0], "Cache-Control": "no-store"}).end(asset[1]);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

async function measure(page) {
  return page.evaluate(async () => {
    const {createPredictor} = await import("/predict.mjs");
    const reference = await (await fetch("/browser-reference.json")).json();
    const results = {};
    for (const variant of ["int8", "float"]) {
      const start = performance.now();
      const response = await fetch("/browser-" + variant + ".json");
      const predictor = createPredictor(await response.json());
      const loadMs = performance.now() - start;
      const times = [];
      let matches = 0;
      const predictions = [];
      for (const {text, context, expected} of reference) {
        const tick = performance.now();
        const result = predictor(text, context);
        times.push(performance.now() - tick);
        if (result.categories.every((value, i) => value === expected[variant].categories[i]) &&
            result.binary.every((value, i) => value === expected[variant].binary[i])) matches++;
        predictions.push(result);
      }
      times.sort((a, b) => a - b);
      results[variant] = {loadMs, matches, cases: reference.length, p95Ms: times[Math.ceil(times.length * .95) - 1], predictions};
    }
    return results;
  });
}

let browser;
try {
  browser = await chromium.launch({executablePath, args: ["--no-sandbox"]});
  const context = await browser.newContext();
  const url = "http://127.0.0.1:" + server.address().port;
  const page = await context.newPage();
  await page.goto(url);
  const online = await measure(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/worker.js");
    await navigator.serviceWorker.ready;
  });
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(url);
  const offline = await measure(reopened);
  for (const variant of ["int8", "float"]) {
    if (online[variant].matches !== online[variant].cases) throw Error(variant + " output differs from Python");
    if (JSON.stringify(online[variant].predictions) !== JSON.stringify(offline[variant].predictions)) {
      throw Error("Offline output changed for " + variant);
    }
    delete online[variant].predictions;
    delete offline[variant].predictions;
  }
  const sizes = Object.fromEntries(names.slice(0, 2).map(name => {
    const bytes = assets.get("/" + name)[1];
    return [name, {bytes: bytes.length, gzipBytes: gzipSync(bytes).length}];
  }));
  console.log(JSON.stringify({browser: browser.version(), cachedOfflineNewPage: true, sizes, online, offline}, null, 2));
} finally {
  await browser?.close();
  server.close();
}
