import {build} from "esbuild";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {performance} from "node:perf_hooks";

const [baselinePath] = process.argv.slice(2);
const scenarios = JSON.parse(await readFile(new URL("../evaluation/luxnora-holdout.json", import.meta.url), "utf8"));
async function load(file) {
  const {outputFiles: [output]} = await build({
    entryPoints: [file], bundle: true, write: false, platform: "node", format: "esm",
  });
  return import("data:text/javascript;base64," + Buffer.from(output.contents).toString("base64"));
}
function signature(plan) {
  const {intent, role, period, operation, schedule} = plan;
  return JSON.parse(JSON.stringify({intent, role, period, operation, schedule}));
}

async function evaluate(label, processTurn, remember) {
  const durations = [];
  const failures = [];
  let turns = 0, matched = 0, conversations = 0, unwantedProposals = 0;
  for (const scenario of scenarios) {
    let context;
    let passed = true;
    for (const turn of scenario.turns) {
      turns++;
      const started = performance.now();
      const result = await processTurn(turn.text, context);
      durations.push(performance.now() - started);
      const actual = result.plans.map(signature);
      context = remember(result, context);
      if (actual.some(plan => (plan.operation || plan.schedule) && !turn.plans.some(expected =>
        expected.operation === plan.operation && isDeepStrictEqual(expected.schedule, plan.schedule)))) unwantedProposals++;
      if (isDeepStrictEqual(actual, turn.plans) && Boolean(result.reset) === Boolean(turn.reset)) {
        matched++;
      } else {
        passed = false;
        failures.push({scenario: scenario.name, input: turn.text, expected: turn.plans, actual});
      }
    }
    if (passed) conversations++;
  }
  durations.sort((a, b) => a - b);
  return {label, matched, turns, conversations, scenarios: scenarios.length, unwantedProposals,
    p50Ms: durations[Math.ceil(durations.length * 0.5) - 1],
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1], failures};
}

if (baselinePath) {
  const {interpret} = await load(resolve(baselinePath, "management-app/src/luxnora/language.ts"));
  console.log(JSON.stringify(await evaluate("baseline / rules", interpret,
    (result, previous) => result.reset ? undefined : result.plans.at(-1) ?? previous), null, 2));
}
const {resolveRequest, rememberRequest} = await load("management-app/src/luxnora/runtime.ts");
const now = Date.parse("2026-11-28T11:00:00+09:00");
const current = await evaluate("v3 / swift",
  (text, context) => resolveRequest(text, context, now, "swift", async () => null),
  (result, previous) => rememberRequest(result, previous, now));
console.log(JSON.stringify(current, null, 2));
if (current.failures.length) process.exitCode = 1;
