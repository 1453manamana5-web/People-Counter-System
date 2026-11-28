import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

const {outputFiles: [output]} = await build({
  entryPoints: ["management-app/src/luxnora/runtime.ts"], bundle: true,
  write: false, platform: "node", format: "esm",
});
const {resolveRequest, rememberRequest, executeRequest} = await import(
  "data:text/javascript;base64," + Buffer.from(output.contents).toString("base64"));
const now = Date.parse("2026-11-28T11:00:00+09:00");
const noModel = async () => null;
const swift = (text, context, at = now) => resolveRequest(text, context, at, "swift", noModel);

test("expired conversation cannot reintroduce a previous metric or time constraint", async () => {
  const first = await swift("午前の入場回数は？");
  const context = rememberRequest(first, undefined, now);
  assert.deepEqual((await swift("午後だけ", context)).plans.map(p => p.period), ["pm"]);
  assert.deepEqual((await swift("午後だけ", context, context.expiresAt)).plans, []);
});

test("only Auto can use the semantic fallback and the result is checked before execution", async () => {
  let calls = 0;
  const read = async () => { calls++; return "stations"; };
  const query = "現物の具合はどうです";
  const result = await resolveRequest(query, undefined, now, "auto", read);
  assert.deepEqual(result.plans.map(({intent, readOnly}) => [intent, readOnly]), [["stations", true]]);
  assert.deepEqual((await resolveRequest(query, undefined, now, "swift", read)).plans, []);
  assert.deepEqual((await resolveRequest("午前だけ", undefined, now, "auto", read)).plans, []);
  assert.deepEqual((await resolveRequest("勘弁してほしい\nこの件もお願い", undefined, now, "auto", read)).plans, []);
  assert.equal(calls, 1);
  assert.deepEqual((await resolveRequest(query, undefined, now, "auto", async () => "event")).plans, []);
  assert.deepEqual((await resolveRequest(query, undefined, now, "auto", async () => {throw Error("offline");})).plans, []);
});

test("trend uses timestamped evidence and withholds stale results", async () => {
  const planned = await swift("さっきより人増えてる？");
  const source = {name:"文化祭",mode:"live",now,current:true,config:{opened:now-30*60_000},stations:[],prediction:[],
    analysis:{occupancy:7,issues:[],timeline:[{at:now-20*60_000,occupancy:3},{at:now-2*60_000,occupancy:7}]}};
  assert.match(executeRequest(planned, source)[0].text,/15分前は3人、現在は7人.*4人増えました/);
  assert.match(executeRequest(planned, {...source,current:false})[0].text,/同期・整合性確認が必要/);
});

test("closing forecast only uses a projection for the same day and exact closing time", async () => {
  const planned = await swift("今のペースだと閉場までにどれくらい来そう？");
  assert.equal(planned.plans[0].horizon,"closing");
  const day = {date:"2026-11-28",end:"11:30"};
  const forecast = at => ({at,occupancy:5,low:2,high:8,entries:40});
  const source = {name:"文化祭",mode:"live",now,current:true,config:null,analysis:null,stations:[],day,
    prediction:[forecast(now+5*60_000),forecast(now+30*60_000)]};
  assert.match(executeRequest(planned, source)[0].text,/11:30頃.*40回/);
  assert.doesNotMatch(executeRequest(planned, source)[0].text,/11:05/);
  assert.match(executeRequest(planned, {...source,prediction:[forecast(now+5*60_000)]})[0].text,/閉場時刻の推計は取得できません/);
});

test("an underspecified comparison requests a baseline and a composed request produces three plans", async () => {
  const relative = await swift("なんか今日少なくない？");
  assert.deepEqual(relative.plans, []);
  assert.match(relative.message, /何と比べますか/);
  const result = await swift("今日の来場状況を分析して、混雑しそうな時間を予測して、入口の端末も確認して");
  assert.deepEqual(result.plans.map(({intent,role})=>[intent,role]), [
    ["briefing",undefined],["forecast",undefined],["stations","in"],
  ]);
});

test("previous-year follow-ups carry the requested metric without reading other series", async () => {
  const first = await swift("午前の退場者数は？");
  const following = await swift("去年は？", rememberRequest(first, undefined, now));
  assert.equal(following.plans[0].comparisonMetric, "exits");
  assert.equal(following.plans[0].period, "am");
  assert.equal(following.plans[0].previousYear, true);
  const explicit = await swift("去年の退場は何回？");
  assert.equal(explicit.plans[0].comparisonMetric, "exits");

  const {outputFiles: [compiled]} = await build({
    entryPoints: ["management-app/src/luxnora/history.ts"], bundle: true,
    write: false, platform: "node", format: "esm",
  });
  const {previousYearDay, previousYearWindow, previousYearAnswer} = await import(
    "data:text/javascript;base64," + Buffer.from(compiled.contents).toString("base64"));
  const selected = {eventId:"festival",date:"2026-11-28"};
  const past = {...selected,date:"2025-11-25",ended:1,finalized:2};
  assert.equal(previousYearDay({days:[past,{...past,eventId:"other"}]},selected),past);
  assert.equal(previousYearDay({days:[past,{...past,date:"2025-11-26"}]},selected),undefined);
  assert.equal(previousYearWindow("am",past.date).to,Date.parse("2025-11-25T12:00:00+09:00"));
  const summary = {date:past.date,status:"verified",issues:0,entries:8,exits:8,duration:100,
    window:{entries:3,exits:2,duration:50}};
  assert.match(previousYearAnswer(following.plans[0],summary).text,/2025-11-25.*午前.*退場 2回/);
  assert.match(previousYearAnswer(following.plans[0],{...summary,status:"provisional"}).text,/確定記録を確認できません/);
});
