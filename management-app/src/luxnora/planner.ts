import {currentComparisonFallback, pendingAnswer, structureObjective} from "./objective";
import {getCapability} from "./capabilities";
import {answer, type Answer, type Evidence} from "./assistant";
import type {ComparisonDay, ComparisonWindow} from "../counterComparisonMetrics";
import type {SeriesAndDays} from "../counterEvents";
import type {Day} from "../counterLifecycle";
import {previousYearDay, previousYearWindow, verifiedComparison} from "./history";
import type {Interpretation, Plan} from "./language";
import {buildKnowledge} from "./knowledgeGraph";
import type {Experience} from "./memory";
import {forecast} from "./forecast";
import {investigate, observeLedger, observeStations} from "./reasoning";

type HistoricalReader = (day: Day, window: ComparisonWindow | undefined, signal: AbortSignal) => Promise<ComparisonDay | undefined>;
type Context = {evidence: Evidence; experiences?: Experience[]; readDeadline?: number; catalog: SeriesAndDays | null; read: HistoricalReader; signal: AbortSignal};
type Results = {
  ledger: ReturnType<typeof observeLedger>;
  stations: ReturnType<typeof observeStations>;
  selectDay: Day | undefined;
  historical: ComparisonDay | undefined;
  respond: Answer;
};
type Capability = keyof Results;
type Access = "read" | "analysis" | "confirmation";
type Node = {id: string; capability: Capability; goal: Plan; dependencies: Node[]; predicate?: {node: Node; when: NonNullable<Interpretation["dependencies"]>[number]["when"]}; access: Access; cost: "local" | "network"};
type Output = Map<string, unknown>;
type Definition<K extends Capability> = {
  inputs: (goal: Plan) => Capability[];
  key: (goal: Plan) => string;
  access: (goal: Plan) => Access;
  cost: Node["cost"];
  run: (context: Context, goal: Plan, input: <I extends Capability>(name: I) => Results[I]) => Results[K] | Promise<Results[K]>;
};
const historyGoal = (plan: Plan) => plan.intent === "compare" && plan.previousYear &&
  typeof plan.period !== "number" && plan.comparisonMetric !== "occupancy";
const counts = new Set(["entries", "exits", "occupancy", "dwell", "briefing", "crowd", "trend", "forecast"]);
const ledgerGoal = (plan: Plan) => counts.has(plan.intent) || plan.intent === "issues";

async function readWithinBudget(context: Context, day: Day, window: ComparisonWindow | undefined) {
  const remaining = Math.min(12_000, (context.readDeadline ?? Infinity)-Date.now());
  if (remaining <= 0 || context.signal.aborted) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const interrupted = new Promise<undefined>(resolve => {
    stop = () => {
      controller.abort();
      resolve(undefined);
    };
    timer = setTimeout(stop, remaining);
    context.signal.addEventListener("abort", stop, {once:true});
  });
  try {
    if (context.signal.aborted) return undefined;
    const summary = await Promise.race([context.read(day, window, controller.signal), interrupted]);
    return summary?.id === day.id && summary.date === day.date ? summary : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", stop);
  }
}

// A snapshot is immutable in the panel. Reuse its independent recount while it is held.
const verifiedSnapshots = new WeakMap<Evidence, Results["ledger"]>();
function verifySnapshot(evidence: Evidence) {
  const existing = verifiedSnapshots.get(evidence);
  if (existing) return existing;
  const checked = observeLedger(evidence);
  verifiedSnapshots.set(evidence, checked);
  return checked;
}

const registry: {[K in Capability]: Definition<K>} = {
  ledger: {inputs: () => [], key: () => "", access: () => "analysis", cost: "local",
    run: ({evidence}) => verifySnapshot(evidence)},
  stations: {inputs: () => [], key: plan => plan.role ?? "", access: () => "read", cost: "local",
    run: ({evidence}, goal) => observeStations(evidence, goal.role)},
  selectDay: {inputs: () => [], key: () => "", access: () => "read", cost: "local",
    run: ({evidence, catalog}) => evidence.mode === "live" && evidence.day ? previousYearDay(catalog, evidence.day) : undefined},
  historical: {inputs: () => ["selectDay"], key: plan => JSON.stringify(plan.period ?? null), access: () => "read", cost: "network",
    run(context, goal, input) {
      const day = input("selectDay");
      return day ? readWithinBudget(context, day, previousYearWindow(goal.period, day.date)) : undefined;
    }},
  respond: {
    inputs(goal) {
      if(goal.guidanceId) return [];
      if (goal.intent === "stations") return ["stations"];
      if (goal.intent === "issues" || goal.condition === "connection-restored") return ["ledger", "stations"];
      if (historyGoal(goal)) return goal.deliverable==="comparison-explanation"?["historical","ledger","stations"]:["historical", "ledger"];
      return ledgerGoal(goal) ? ["ledger"] : [];
    },
    key: plan => JSON.stringify(plan),
    access: plan => plan.operation || plan.schedule ? "confirmation" : ledgerGoal(plan) ? "analysis" : "read",
    cost: "local",
    run({evidence,experiences}, goal, input) {
      if(goal.guidanceId) {
        const entry=getCapability(goal.guidanceId)!;
        return {text:entry.guide,source:entry.source};
      }
      if (goal.intent === "stations") {
        const stations=input("stations");
        const objective=structureObjective(goal,evidence);
        if(objective?.result==="pending-records") return pendingAnswer(objective,stations);
        const available=stations.filter(row=>row.quality==="current"&&row.value.station);
        const hasSignal=available.some(({value:{station}})=>station&&
          (station.pending!=null&&station.pending>0 || station.camera===false||station.ai===false||
            ["storage","network","camera","recalibrate"].includes(station.alert??"")));
        const complete=available.length===stations.length&&available.every(({value:{station}})=>
          station?.pending!=null && station.camera!=null && station.ai!=null && station.alert!=null);
        return {...answer(goal,evidence), diagnosticSignal:hasSignal?true:complete?false:undefined};
      }
      if (goal.intent === "issues") {
        const ledger = input("ledger");
        const stations = input("stations");
        const graph = buildKnowledge(evidence,ledger,stations,experiences);
        const result = investigate(ledger,stations);
        const priorRecount = graph.links.some(link=>link.relation==="has-experience"&&link.to==="ledger-recount");
        const activeMismatch = ledger.value && !ledger.value.consistent;
        const advice = priorRecount && activeMismatch ? "\nこの開催区分では以前も集計値の再計算が必要でした。現在の台帳と集計経路を確認してください。" : "";
        return {diagnosticSignal:result.hypotheses.some(item=>item.supporting.length>0)?true:undefined,text:(goal.period === undefined ? "" : "台帳は開催日全体、端末は取得済みの最新報告を確認しました。\n")+result.text+advice};
      }
      if (goal.condition === "connection-restored") {
        const stations = input("stations");
        const reported = stations.flatMap(row => {
          const pending = row.value.station?.pending;
          return pending == null ? [] : [(row.value.side === "in" ? "入口" : "出口")+"の端末報告は未同期 "+pending+"件"];
        });
        return {text:[...reported,"復旧後に記録が届けば集計が変わることがあります。件数には訂正なども含まれ得るため、人数への影響は推計できません。同期後の台帳で確認できます。"].join("。")};
      }
      if (historyGoal(goal)) {
        const summary = input("historical");
        const ledger=input("ledger");
        const comparison=summary?verifiedComparison(goal,summary,evidence,ledger):{target:"compare" as const,text:
          "前年の確定日を一意に特定できないか、記録を取得できませんでした。年度比較画面で対象日と通信状態を確認してください。"};
        if(goal.deliverable!=="comparison-explanation") return comparison;
        const delta=comparison.comparisonDelta;
        const verified=delta!==undefined;
        const contradicted=delta!==undefined && (goal.expectedDifference==="lower"&&delta>=0||
          goal.expectedDifference==="higher"&&delta<=0);
        if(contradicted) {
          return {...comparison,text:comparison.text+(goal.expectedDifference==="lower"?
            " 今回の記録は前年を下回っていません。":" 今回の記録は前年を上回っていません。"),
            source:"確定した両開催日の通過台帳",
            objective:{result:goal.deliverable,status:"verified"}};
        }
        const diagnosis=investigate(ledger,input("stations"));
        const fallback=verified?undefined:currentComparisonFallback(goal,evidence,ledger);
        const hypotheses=diagnosis.hypotheses.filter(row=>row.supporting.length);
        const details=hypotheses.map(row=>row.label+"。根拠は"+row.supporting.join("、")+
          "。確認に必要なのは"+row.missing.join("、")+"です。");
        return {...comparison,text:[comparison.text,fallback?.text,
          verified?"記録上の差から原因を確定することはできません。":"比較条件または前年の記録が不足しているため、差の原因は判断できません。",
          ...details].filter(Boolean).join("\n"),
          source:fallback?.source??(verified?"確定した両開催日の通過台帳":undefined),
          objective:{result:goal.deliverable,status:verified||fallback?"partial":"missing",
            missing:verified?["causal-evidence"]:["verified-comparison","causal-evidence"]}};
      }
      if (ledgerGoal(goal)) {
        const ledger = input("ledger");
        if(goal.at!==undefined) {
          const at=goal.at;
          if(goal.intent!=="occupancy"||!Number.isFinite(at)||ledger.from==null||ledger.to==null||
            at<ledger.from||at>ledger.to||!ledger.value?.consistent||ledger.value.issues.length||!evidence.analysis) {
            return {text:"グラフで選んだ時刻の滞在人数を台帳で確認できませんでした。"};
          }
          const point=evidence.analysis.timeline.filter(row=>row.at<=at).at(-1);
          const occupancy=point?.occupancy??0;
          if(occupancy<0) return {text:"グラフで選んだ時刻の滞在人数を台帳で確認できませんでした。"};
          const time=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(at);
          return {text:time+"の滞在は"+occupancy+"人です。"+(evidence.current||evidence.sealed?"":"取得済みの暫定記録です。"),source:"選択中の開催日の通過台帳"};
        }
        const recount = ledger.value;
        if (recount && !recount.consistent && recount.timelineMatches && recount.occupancy >= 0 &&
            evidence.ledgerFromServer && evidence.current && recount.pending === 0 && !recount.issues.length &&
            goal.period === undefined && (goal.intent === "entries" || goal.intent === "exits" || goal.intent === "occupancy")) {
          const value = goal.intent === "entries" ? "入場 "+recount.entries+"回" :
            goal.intent === "exits" ? "退場 "+recount.exits+"回" : "滞在 "+recount.occupancy+"人";
          return {text:evidence.name+"（"+(evidence.mode==="live"?"本番":"試験")+"）の台帳を独立に再集計しました。"+value+"です。",verification:"recount"};
        }
        if ((recount && (!recount.consistent || recount.occupancy < 0)) ||
            (!recount && evidence.analysis)) {
          return {text:"台帳と人数の整合性を確認できなかったため、集計結果の提示を保留しました。"};
        }
        if (goal.intent === "forecast" && (ledger.quality !== "current" || ledger.value?.issues.length)) {
          return {target:"graph", text:"同期済みで整合性を確認できる通過記録が揃うまで、混雑予測を保留します。"};
        }
      }
      if (goal.intent === "forecast" && goal.minutesAhead !== undefined) {
        const day = evidence.day;
        const opened = evidence.config?.opened;
        if (opened == null || !day || !evidence.prediction.length || !evidence.analysis) {
          return {text:"同じペースが続く場合の推計に必要な、開催時刻と安定した通過記録が揃っていません。"};
        }
        const prediction = forecast({now:evidence.now, opened,
          ends:Date.parse(day.date+"T"+day.end+":00+09:00"), healthy:true, minutesAhead:goal.minutesAhead,
          total:evidence.analysis.entries, occupancy:evidence.analysis.occupancy, events:evidence.analysis.effective});
        if (!prediction.length) return {text:"指定時間は閉場予定を超えるか、推計可能な時間範囲外です。"};
        return {target:"graph", text:"今のペースが続く場合の推計です。"+answer(goal,{...evidence,prediction}).text};
      }
      return answer(goal, evidence);
    },
  },
};

export function compilePlan(request: Interpretation) {
  if (request.plans.length > 4) throw new Error("Too many goals");
  if(request.plans.some(goal=>goal.guidanceId!==undefined&&(!getCapability(goal.guidanceId)||
    goal.intent!=="briefing"||!goal.readOnly||goal.focus||goal.operation||goal.schedule||goal.at!==undefined)))
    throw new Error("Invalid guidance goal");
  if (request.plans.some(goal=>goal.at!==undefined&&(!Number.isFinite(goal.at)||goal.intent!=="occupancy"||
    !goal.readOnly||goal.period!==undefined))) throw new Error("Invalid chart selection");
  if(request.plans.some(goal=>goal.deliverable!==undefined &&
    (!goal.readOnly||goal.operation||goal.schedule||goal.guidanceId||goal.at!==undefined||
     (goal.deliverable==="pending-records"?goal.intent!=="stations"||goal.period!==undefined:
      goal.deliverable!=="comparison-explanation"||!historyGoal(goal)))))
    throw new Error("Invalid deliverable");
  if(request.plans.some(goal=>goal.expectedDifference!==undefined&&
    (goal.deliverable!=="comparison-explanation"||!["lower","higher"].includes(goal.expectedDifference)))) {
    throw new Error("Invalid comparison premise");
  }
  const edges=request.dependencies??[];
  if (new Set(edges.map(edge=>edge.task)).size!==edges.length || edges.some(edge=>
    !Number.isInteger(edge.task)||!Number.isInteger(edge.after)||edge.after<0||
    edge.task>=request.plans.length||edge.after>=edge.task)) throw new Error("Invalid goal dependency");
  if (request.plans.some(goal => (goal.operation || goal.schedule) &&
    (request.constraints?.readOnly || request.plans.length !== 1 || goal.intent !== "event" || goal.readOnly || Boolean(goal.operation && goal.schedule)))) {
    throw new Error("Invalid confirmation goal");
  }
  const nodes = new Map<string, Node>();
  const visiting = new Set<Capability>();
  function visit(capability: Capability, goal: Plan): Node {
    const definition = registry[capability];
    const id = capability + ":" + definition.key(goal);
    const existing = nodes.get(id);
    if (existing) return existing;
    if (visiting.has(capability)) throw new Error("Circular capability dependency");
    visiting.add(capability);
    const dependencies = definition.inputs(goal).map(name => visit(name, goal));
    visiting.delete(capability);
    const node = {id, capability, goal, dependencies, access: definition.access(goal), cost: definition.cost};
    nodes.set(id, node);
    return node;
  }
  const outputs: Node[] = [];
  for (const [index, plan] of request.plans.entries()) {
    const base=visit("respond",plan);
    const predicate=edges.find(dep=>dep.task===index);
    if(!predicate) {outputs.push(base);continue;}
    const prior=outputs[predicate.after];
    if(!prior || plan.intent!=="issues" || !plan.readOnly ||
        (predicate.when==="previous-year-lower"?prior.goal.intent!=="compare":
          predicate.when!=="anomaly"||!["stations","issues"].includes(prior.goal.intent))) {
      throw new Error("Invalid conditional goal");
    }
    const node:Node={...base,id:base.id+":conditional:"+index,dependencies:[...base.dependencies,prior],
      predicate:{node:prior,when:predicate.when}};
    nodes.set(node.id,node);
    outputs.push(node);
  }
  const referenced=new Set<Node>();
  function collect(node:Node) {
    if(referenced.has(node)) return;
    referenced.add(node);
    node.dependencies.forEach(collect);
  }
  outputs.forEach(collect);
  const active=[...nodes.values()].filter(node=>referenced.has(node));
  const method = request.plans.some(plan => plan.intent === "issues" || plan.condition === "connection-restored") ? "advanced" :
    outputs.length > 1 || [...nodes.values()].some(node => node.cost === "network") ? "standard" : "light";
  return {nodes: active, outputs, method};
}

type Trace = {capability: Capability; status: "completed" | "fallback"};
export async function runPlan(request: Interpretation, context: Context, allowConfirmation: boolean) {
  const {outputs, method} = compilePlan(request);
  const values: Output = new Map();
  const trace: Trace[] = [];
  const work=new Map<string,Promise<void>>();
  let networkTail=Promise.resolve();
  function run(node:Node):Promise<void> {
    const existing=work.get(node.id);
    if(existing) return existing;
    const task=(async()=>{
      if (context.signal.aborted) throw new Error("Request cancelled");
      // A false or unverified predicate leaves its private inputs unexecuted.
      if(node.predicate) await run(node.predicate.node);
      const prior=node.predicate?values.get(node.predicate.node.id) as Answer:undefined;
      const condition=node.predicate?.when==="previous-year-lower" ?
        (prior?.comparisonDelta===undefined?undefined:prior.comparisonDelta<0) : prior?.diagnosticSignal;
      const skipped=Boolean(node.predicate)&&condition!==true;
      const blocked = node.access === "confirmation" && !allowConfirmation;
      let result:unknown;
      if(blocked) result={text:"操作候補が古くなりました。必要な場合はもう一度指示してください。"};
      else if(skipped) result={text:condition===false?"条件に当てはまらなかったため、追加の原因調査は行いませんでした。":
        "条件を確認できなかったため、追加の原因調査は保留しました。"};
      else {
        await Promise.all(node.dependencies.map(run));
        const input = <I extends Capability>(name: I): Results[I] => {
          const dependency=node.dependencies.find(dep=>dep.capability===name);
          if(!dependency||!values.has(dependency.id)) throw new Error("Missing capability input");
          return values.get(dependency.id) as Results[I];
        };
        const execute=()=>{
          if(context.signal.aborted) throw new Error("Request cancelled");
          return registry[node.capability].run(context,node.goal,input);
        };
        if(node.cost==="network") {
          const read=networkTail.then(execute);
          networkTail=read.then(()=>{},()=>{});
          result=await read;
        } else result=await execute();
      }
      if(context.signal.aborted) throw new Error("Request cancelled");
      values.set(node.id,result);
      trace.push({capability:node.capability,status:blocked||skipped||
        node.capability==="historical"&&result===undefined?"fallback":"completed"});
    })();
    work.set(node.id,task);
    return task;
  }
  await Promise.all(outputs.map(run));
  return {answers:outputs.map(node=>values.get(node.id) as Answer),method,trace};
}
