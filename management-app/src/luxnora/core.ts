import {recallCorrection, type ContextMemory} from "./context";
import {runPlan} from "./planner";
import {resolveRequest, type Profile} from "./runtime";
import type {ComparisonDay} from "../counterComparisonMetrics";

type Snapshot = Omit<Parameters<typeof runPlan>[1], "read" | "signal" | "readDeadline">;

export async function processLuxnoraRequest(input: {
  text: string; profile: Profile; context: ContextMemory; signal: AbortSignal;
  observe: () => Snapshot; allowConfirmation: () => boolean;
  semantic: (text:string,signal:AbortSignal) => Promise<import("./language").Intent|null>;
  read: Parameters<typeof runPlan>[1]["read"];
}) {
  const {text,profile,context,signal,observe,allowConfirmation}=input;
  const now=Date.now();
  const request=recallCorrection(text,context,now) ??
    await resolveRequest(text,context.focus,now,profile,raw=>input.semantic(raw,signal));
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
  return {request,answers:result.answers,experiences};
}
