import {readFile} from "node:fs/promises";

import {predict} from "./predict.mjs";

export async function measure() {
  const loadStart=performance.now();
  const model=JSON.parse(await readFile(new URL("./linear-browser.json",import.meta.url),"utf8"));
  const loadMs=performance.now()-loadStart;
  const data=JSON.parse(await readFile(new URL("./structured.json",import.meta.url),"utf8")).independent;
  const prior=JSON.parse(await readFile(new URL("./metrics.json",import.meta.url),"utf8"))
    .models.linear.independent.predictions;
  const times=[];
  const rows=data.map((row,index)=>{
    const start=performance.now();
    const actual=predict(model,row.text);
    times.push(performance.now()-start);
    if(actual!==prior[index]) throw new Error("Quantized JavaScript and Python disagree at "+index);
    return {text:row.text,expected:row.capability,actual};
  });
  times.sort((a,b)=>a-b);
  return {loadMs,p95Ms:times[Math.ceil(times.length*.95)-1],peakRssKiB:process.resourceUsage().maxRSS,
    cases:rows.length,matched:rows.filter(row=>row.expected===row.actual).length,rows};
}
console.log(JSON.stringify(await measure(),null,2));
