import {applicationGoal, extractAdvice, fulfillApplication, groundedAdvice, screenRequest} from "./application";
import type {ViewState} from "./capabilities";
import type {ContextMemory} from "./context";
import {resolveLanguage} from "./understanding";
import {runPlan} from "./planner";
import type {Profile} from "./runtime";
import type {ComparisonDay} from "../counterComparisonMetrics";

type Snapshot = Omit<Parameters<typeof runPlan>[1], "read" | "signal" | "readDeadline"> & {view?:ViewState};

export async function processLuxnoraRequest(input: {
  text: string; profile: Profile; context: ContextMemory; signal: AbortSignal;
  observe: () => Snapshot; allowConfirmation: () => boolean;
  semantic: (text:string,signal:AbortSignal) => Promise<import("./language").Intent|null>;
  read: Parameters<typeof runPlan>[1]["read"];
}) {
  const {text,profile,context,signal,observe,allowConfirmation}=input;
  const now=Date.now();
  const initial=observe();
  if(signal.aborted) return undefined;
  const goal=applicationGoal(text,initial.view);
  if(goal) return {request:{plans:[]},answers:fulfillApplication(goal,initial.evidence,initial.view),experiences:[]};

  const advice=extractAdvice(text);
  const standaloneAdvice=/^(?:来年|次回)(?:は|の)(?:運営を)?(?:どう改善すればいい|改善点(?:を)?(?:教えて|まとめて))$/.
    test(text.normalize("NFKC").trim().replace(/[。!?]+$/,""));
  const request=screenRequest(text,initial.view) ??
    (standaloneAdvice?{plans:[{intent:"issues",readOnly:true,focus:false}]} satisfies import("./language").Interpretation:undefined) ??
    await resolveLanguage(advice??text,context,now,profile,raw=>input.semantic(raw,signal));
  if(advice&&request.plans.some(plan=>plan.operation||plan.schedule)) {
    return {request:{plans:[]},answers:[{text:"変更操作と改善案は別々に依頼してください。"}],experiences:[]};
  }
  if (signal.aborted) return undefined;

  const cache=new Map<string,ComparisonDay|undefined>();
  const read:Parameters<typeof runPlan>[1]["read"]=async (day,window,child)=>{
    if(child.aborted) return undefined;
    const key=JSON.stringify([day.id,window]);
    if(cache.has(key)) return cache.get(key);
    try {
      const summary=await input.read(day,window,child);
      if(!child.aborted) cache.set(key,summary);
      return summary;
    } catch {
      if(!child.aborted) cache.set(key,undefined);
      return undefined;
    }
  };
  const readDeadline=Date.now()+12_000;
  const snapshot=observe();
  let result=await runPlan(request,{...snapshot,read,signal,readDeadline},allowConfirmation());
  if(signal.aborted) return undefined;
  const refreshed=observe();
  if(request.plans.some(plan=>plan.at!==undefined&&
    (refreshed.view?.page!=="analysis"||plan.at!==refreshed.view.chartAt||refreshed.evidence.scope!==initial.evidence.scope))) {
    return {request:{plans:[]},answers:[{text:"選択した時刻が変わりました。グラフを確認してからもう一度聞いてください。"}],experiences:[]};
  }
  if(refreshed.evidence!==snapshot.evidence || refreshed.catalog!==snapshot.catalog) {
    result=await runPlan(request,{...refreshed,read,signal,readDeadline},false);
    if(signal.aborted) return undefined;
    const latest=observe();
    if(latest.evidence!==refreshed.evidence || latest.catalog!==refreshed.catalog) {
      return {request:{plans:[]},answers:[{text:"確認中に運用データが更新されました。最新の結果が必要な場合は再度依頼してください。"}],experiences:[]};
    }
  }
  const experiences: import("./memory").ExperienceKind[]=[];
  if(result.answers.some(row=>row.verification==="recount")) experiences.push("ledger-recount");
  if(result.trace.some(row=>row.capability==="historical"&&row.status==="fallback")) experiences.push("history-unavailable");
  const answers=(advice||standaloneAdvice)&&request.plans.length&&!request.reset
    ? [...result.answers,groundedAdvice(request,observe().evidence,result.answers)] : result.answers;
  return {request,answers,experiences};
}
