import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const base=new URL("./counter-app/public/people-counter/",import.meta.url);
const read=p=>readFileSync(new URL(p,base),"utf8");
test("station UI retains unique control IDs and defaults to the counting screen",()=>{
 const html=read("index.html"),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length);
 for(const id of ["video","overlay","cameraFrame","startButton","stopButton","ledgerSetup","ledgerEvent","counterStationApply","ledgerEdit","adaptiveStart","trialStart","total","history","prepareOffline","ledgerError","ledgerState","stationEventTotals"])assert.ok(ids.includes(id),id);
 for(const page of ["setup","adjust","records"])assert.match(html,new RegExp('data-screen="'+page+'" hidden'));
 assert.match(html,/data-screen="capture adjust"/);
});
test("station screen script and updated ledger shell are available offline",()=>{
 const sw=read("counter-offline.js"),html=read("index.html"),ledger=read("ledger-ui.mjs");
 for(const asset of ["style.css?v=18","ledger-ui.mjs?v=18","station-ui.mjs?v=1"]) {assert.ok(html.includes(asset));assert.ok(sw.includes(asset));}
 assert.ok(sw.includes("pcs-counter-v19"));assert.ok(ledger.includes("pcs-counter-v19"));
});
