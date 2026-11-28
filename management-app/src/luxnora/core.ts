import {applicationGoal, extractAdvice, fulfillApplication, groundedAdvice, mixedGuide, screenRequest} from "./application";
import {countImprovement,followupAdvice,improvementAnswer} from "./workflow";
import type {createHistoryMemo} from "./session";
import type {ViewState} from "./capabilities";
import {activeTopics, contextualRevision, scopedContext, type ContextMemory, type ReferenceTopic} from "./context";
import {resolveLanguage} from "./understanding";
import {compilePlan, runPlan} from "./planner";
import {interpret} from "./language";
import type {Profile} from "./runtime";
import type {ComparisonDay} from "../counterComparisonMetrics";

type Snapshot = Omit<Parameters<typeof runPlan>[1], "read" | "signal" | "readDeadline"> & {view?:ViewState};

export async function processLuxnoraRequest(input: {
  text: string; profile: Profile; context: ContextMemory; signal: AbortSignal;
  observe: () => Snapshot; allowConfirmation: () => boolean;
  semantic: (text:string,signal:AbortSignal) => Promise<import("./language").Intent|null>;
  shadow?: {
    predict:(state:{text:string;topics:readonly ReferenceTopic[];active?:ReferenceTopic}, signal:AbortSignal)=>Promise<unknown>;
    report:(value:{candidate:import("./language").Interpretation;baseline:import("./language").Interpretation;
      capabilities:string[]})=>void;
  };
  memo?: ReturnType<typeof createHistoryMemo>;
  read: Parameters<typeof runPlan>[1]["read"];
}) {
  const {text,profile,signal,observe,allowConfirmation}=input;
  const now=Date.now();
  const initial=observe();
  const context=scopedContext(input.context,initial.view?.ready?initial.evidence.scope:undefined);
  if(signal.aborted) return undefined;
  if(!initial.view?.ready) input.memo?.clear();
  if(initial.view?.ready===false) {
    return {request:{plans:[]},answers:[{text:"閲覧権限を確認できません。管理画面で権限を確認してから再度依頼してください。"}],experiences:[]};
  }
  const workflow=countImprovement(text,initial.evidence);
  const mixed=workflow?undefined:mixedGuide(text,initial.view,part=>interpret(part).plans);
  const goal=workflow||mixed||contextualRevision(text,context,now)?undefined:applicationGoal(text,initial.view);
  if(goal) return {request:{plans:[]},answers:fulfillApplication(goal,initial.evidence,initial.view),experiences:[]};

  const advice=extractAdvice(text);
  const standaloneAdvice=/^(?:来年|次回)(?:は|の)(?:運営を)?(?:どう改善すればいい|改善点(?:を)?(?:教えて|まとめて))$/.
    test(text.normalize("NFKC").trim().replace(/[。!?]+$/,""));
  const stationTopic=context.topics.station;
  const previousStation=stationTopic&&stationTopic.expiresAt>now&&stationTopic.plans.length===1?
    stationTopic.plans[0]:undefined;
  const followup=followupAdvice(text);
  const request:import("./language").Interpretation=workflow?.request ?? mixed ?? screenRequest(text,initial.view) ??
    (followup?{plans:[{intent:"issues",readOnly:true,focus:false,role:previousStation?.role}]} satisfies import("./language").Interpretation:undefined) ??
    (standaloneAdvice?{plans:[{intent:"issues",readOnly:true,focus:false}]} satisfies import("./language").Interpretation:undefined) ??
    await resolveLanguage(advice??text,context,now,profile,raw=>input.semantic(raw,signal));
  if(advice&&request.plans.some(plan=>plan.operation||plan.schedule)) {
    return {request:{plans:[]},answers:[{text:"変更操作と改善案は別々に依頼してください。"}],experiences:[]};
  }
  if (signal.aborted) return undefined;

  let usedMemo=false;
  const cache=new Map<string,ComparisonDay|undefined>();
  const read:Parameters<typeof runPlan>[1]["read"]=async (day,window,child)=>{
    if(child.aborted) return undefined;
    const scope=initial.evidence.scope;
    const current=observe();
    if(current.evidence.scope!==scope||current.evidence.mode!==initial.evidence.mode||
        current.view?.ready!==initial.view?.ready||current.view?.ready===false) return undefined;
    const reusable=scope&&initial.view?.ready&&current.view?.ready&&
      current.evidence.scope===scope&&!/最新|再取得|やり直/.test(text);
    const existing=reusable?input.memo?.get(scope,day,window,Date.now()):undefined;
    if(existing) {
      usedMemo=true;
      return existing;
    }
    const key=JSON.stringify([day.id,day.date,day.eventId,day.version,day.finalized,window]);
    if(cache.has(key)) return cache.get(key);
    try {
      const summary=await input.read(day,window,child);
      if(!child.aborted) {
        cache.set(key,summary);
        const latest=observe();
        if(reusable&&summary&&latest.view?.ready&&latest.evidence.scope===scope) {
          input.memo?.put(scope,day,window,summary,Date.now());
        }
      }
      return summary;
    } catch {
      if(!child.aborted) cache.set(key,undefined);
      return undefined;
    }
  };
  const readDeadline=Date.now()+12_000;
  const snapshot=observe();
  const staleScope=(snapshot:Snapshot)=>snapshot.evidence.scope!==initial.evidence.scope ||
    snapshot.evidence.mode!==initial.evidence.mode || snapshot.view?.ready!==initial.view?.ready;
  const scopeChanged=()=>({request:{plans:[]},answers:[{text:"開催日または閲覧状態が変わりました。閲覧権限を再確認してからもう一度依頼してください。"}],experiences:[]});
  if(staleScope(snapshot)) return scopeChanged();
  let result=await runPlan(request,{...snapshot,read,signal,readDeadline},allowConfirmation());
  if(signal.aborted) return undefined;
  const refreshed=observe();
  if(staleScope(refreshed)) return scopeChanged();
  if(request.plans.some(plan=>plan.at!==undefined&&
    (refreshed.view?.page!=="analysis"||plan.at!==refreshed.view.chartAt||refreshed.evidence.scope!==initial.evidence.scope))) {
    return {request:{plans:[]},answers:[{text:"選択した時刻が変わりました。グラフを確認してからもう一度聞いてください。"}],experiences:[]};
  }
  if(refreshed.evidence!==snapshot.evidence || refreshed.catalog!==snapshot.catalog) {
    result=await runPlan(request,{...refreshed,read,signal,readDeadline},false);
    if(signal.aborted) return undefined;
    const latest=observe();
    if(staleScope(latest)) return scopeChanged();
    if(latest.evidence!==refreshed.evidence || latest.catalog!==refreshed.catalog) {
      return {request:{plans:[]},answers:[{text:"確認中に運用データが更新されました。最新の結果が必要な場合は再度依頼してください。"}],experiences:[]};
    }
  }
  const latest=observe();
  if(usedMemo&&(!latest.view?.ready||latest.evidence.scope!==initial.evidence.scope)) {
    input.memo?.clear();
    return {request:{plans:[]},answers:[{text:"以前の比較を表示する前に、開催区分と閲覧権限を再確認してください。"}],experiences:[]};
  }
  const experiences: import("./memory").ExperienceKind[]=[];
  if(result.answers.some(row=>row.verification==="recount")) experiences.push("ledger-recount");
  if(result.trace.some(row=>row.capability==="historical"&&row.status==="fallback")) experiences.push("history-unavailable");
  const answers=workflow&&!request.reset?[...result.answers,improvementAnswer(workflow,latest.evidence,result.answers)]:
    (advice||standaloneAdvice||followup)&&request.plans.length&&!request.reset
    ? [...result.answers,groundedAdvice(request,latest.evidence,result.answers)] : result.answers;
  if(input.shadow && contextualRevision(text,context,now)) {
    const shadow=input.shadow;
    // Detached and observational. No read callback, focus, or approval is
    // available to the preview plan, and the ordinary response never waits.
    const state={text,topics:activeTopics(context,now),active:context.active};
    void Promise.resolve().then(()=>shadow.predict(state,signal)).then(topic=>{
      if(signal.aborted || staleScope(observe())) return;
      if(topic!=="clarify" && !state.topics.some(id=>id===topic)) return;
      const candidate=contextualRevision(text,context,now,topic);
      if(!candidate) return;
      const compiled=compilePlan(candidate);
      if(compiled.nodes.some(node=>node.access==="confirmation")) return;
      shadow.report({candidate,baseline:request,capabilities:compiled.nodes.map(node=>node.capability)});
    }).catch(()=>{});
  }
  return {request,answers,experiences};
}
