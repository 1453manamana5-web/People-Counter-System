import {interpret, type Interpretation, type Plan} from "./language";
import {rememberRequest, type Conversation} from "./runtime";

const ttl = 5 * 60_000;
export type Topic = "comparison" | "station" | "count" | "records" | "diagnosis";
export type ReferenceTopic = Topic | "clarify";
type TopicMemory = {plans: Plan[]; expiresAt: number};
export type ContextMemory = {
  scope?: string;
  focus?: Conversation;
  prior?: Conversation;
  topics: Partial<Record<Topic, TopicMemory>>;
  active?: Topic;
  previous?: Partial<Record<Topic, TopicMemory>>;
  outcomes?: Partial<Record<Topic, {state:"answered"|"partial"; at:number}>>;
};

export function scopedContext(memory:ContextMemory, scope:string|undefined) {
  return memory.scope===scope ? memory : {scope,topics:{}};
}

function topicOf(plan:Plan):Topic|undefined {
  switch(plan.intent) {
    case "compare": return "comparison";
    case "stations": return "station";
    case "entries": case "exits": case "occupancy": case "crowd": case "dwell": return "count";
    case "records": return "records";
    case "issues": return "diagnosis";
  }
}

export function activeTopics(memory:ContextMemory, now:number):Topic[] {
  return (Object.keys(memory.topics) as Topic[]).filter(topic=>{
    const item=memory.topics[topic];
    return item && item.expiresAt>now && item.plans.length===1;
  });
}

// Only bounded, read-only revisions can select a stored topic. The chosen
// topic does not supply parameters, writes, or permission.
function revision(text:string) {
  const period=/午前(?:中)?|午後|全体|終日/.exec(text)?.[0];
  const back=/(?:元の|前の|さっきの)条件に戻|元に戻して/.test(text);
  const more=/(?:改めて|そのまま)(?:詳しく)?(?:確認|見せ|調べ|続け)|(?:もう(?:一度|少し|ちょっと)|もっと|改めて|そのまま).*(?:詳しく|続け|確認|お願い|見せ|調べ)|(?:同じ条件|さっきと同じ)(?:で|に)/.test(text);
  const change=period!==undefined && /(?:だけ|変え|変更|限定|絞|にして|でいい|に修正|に訂正|でお願い|の分で)/.test(text);
  if(!back&&!more&&!change) return undefined;
  const topics:Topic[]=[];
  if(/比較|前年|去年|年度|その差/.test(text)) topics.push("comparison");
  if(/端末|カメラ/.test(text)) topics.push("station");
  if(/人数|回数|集計/.test(text) && !topics.includes("comparison")) topics.push("count");
  if(/台帳|履歴|記録/.test(text)) topics.push("records");
  if(/原因|整合性|診断/.test(text)) topics.push("diagnosis");
  return {topic:topics.length===1?topics[0]:undefined, ambiguous:topics.length>1, back, change,
    period:period==="午後"?"pm" as const:period?.startsWith("午前")?"am" as const:undefined};
}

export function contextualRevision(raw:string, memory:ContextMemory, now:number, candidate?:unknown):Interpretation|undefined {
  if(raw.length>180) return undefined;
  const text=raw.normalize("NFKC").trim();
  if(/[\n；;]|開場|閉場|再起動|解除|削除|取り消|キャンセル|権限|設定|しない|しなく|せず|せんといて|待って/.test(text)) return undefined;
  if(/(?:確認して|見せて|調べて|教えて)[。！？!?、]|そのあと|それから|ついでに|そして/.test(text.replace(/[。！？!?]+$/,""))) return undefined;
  if(/比べて|比較して|教えて/.test(text) && (/(?:今年|今年度|今日)と|来場回数を|入場回数を/.test(text))) return undefined;
  const edit=revision(text);
  if(!edit) return undefined;
  const active=activeTopics(memory,now);
  const eligible=active.filter(topic=>!edit.change||!["station","diagnosis"].includes(topic));
  const focus=memory.active && eligible.includes(memory.active)?memory.active:undefined;
  const selected=edit.topic ?? (candidate===undefined?focus??(eligible.length===1?eligible[0]:undefined):
    eligible.find(topic=>topic===candidate));
  if(!selected || edit.ambiguous || !eligible.includes(selected)) {
    return {plans:[],message:"どの結果や条件についてですか？ 比較・集計などの対象を指定してください。"};
  }
  const item=edit.back?memory.previous?.[selected]:memory.topics[selected];
  if(!item || item.expiresAt<=now || item.plans.length!==1) {
    return {plans:[],message:"引き継げる条件を特定できません。対象と条件を指定してください。"};
  }
  const [plan]=item.plans;
  if(plan.operation||plan.schedule||plan.at!==undefined||!plan.readOnly) return undefined;
  return {plans:[{...plan,focus:false,...(edit.change?{period:edit.period}:{})}],constraints:{readOnly:true}};
}


export function recallCorrection(raw: string, memory: ContextMemory, now: number): Interpretation | undefined {
  const text = raw.normalize("NFKC").replace(/\s|[。?!]/g, "");
  const focus=memory.focus&&memory.focus.expiresAt>now?memory.focus.plan:undefined;
  const update=/^(?:じゃあ|では)?(午前(?:中)?|午後|全体)(?:に|へ)(?:変えて|変更して|戻して|して)(?:ください)?$/.exec(text);
  const metric=/^(入場|来場|退場|退出)(?:の方|のほう)?(?:も|だけ|は)(?:確認して|お願い)?$/.exec(text);
  if (update||metric&&focus?.intent==="compare") {
    if(!focus) return {plans:[],message:"どの集計や比較の時間帯を変えますか？"};
    if(update&&["stations","readiness","records","forecast"].includes(focus.intent)) {
      return {plans:[],message:"どの集計や比較の時間帯を変えますか？"};
    }
    if(metric) return {plans:[{...focus,readOnly:true,comparisonMetric:/退場|退出/.test(metric[1])?"exits":"entries"}]};
    const period=update?.[1]==="全体"?undefined:update?.[1]==="午後"?"pm":"am";
    return {plans:[{...focus,readOnly:true,period}]};
  }
  if (/^(?:さっきのやつに戻して|前の条件に戻して|もうちょっと詳しく|もう少し詳しく)$/.test(text)) {
    const back=text.includes("戻して");
    const reference=back?memory.prior:memory.focus;
    return reference&&reference.expiresAt>now?{plans:[{...reference.plan,readOnly:true}]}:
      {plans:[],message:"どの結果や条件を確認しますか？"};
  }
  const compare = /^(?:比較の方|比較のほう|比較)(?:は|を)(午前(?:中)?|午後|全体)(?:に|へ)(?:変えて|変更して|して)(?:ください)?$/.exec(text);
  const station = /^(?:端末は)?(入口|出口)(も|だけ)(?:追加して|確認して|見て|にして)(?:ください)?$/.exec(text);
  if (!compare && !station) return undefined;
  const topic = compare ? "comparison" : "station";
  const previous = memory.topics[topic];
  if (!previous || now >= previous.expiresAt || (compare && previous.plans.length !== 1)) {
    if (station && !text.startsWith("端末は") && !text.includes("追加")) return undefined;
    return {plans: [], message: "引き継ぐ対象を特定できません。比較する開催日、または確認する端末を指定してください。"};
  }
  if (compare) {
    const period = compare[1] === "全体" ? undefined :
      interpret(compare[1]+"だけ",previous.plans[0]).plans[0]?.period;
    return {plans: [{...previous.plans[0], period}]};
  }
  if (!station) return undefined;
  const role = station[1] === "入口" ? "in" : "out";
  const next: Plan = {intent:"stations", role, readOnly:true, focus:true};
  const same = previous.plans.some(plan=>plan.role === role);
  if (station[2] === "だけ") return {plans:[next]};
  if (previous.plans.some(plan=>plan.role === undefined)) return {plans:[{...next, role:undefined}]};
  return {plans:same ? previous.plans : [...previous.plans,next]};
}

export function rememberTopics(request: Interpretation, memory: ContextMemory, now: number): ContextMemory {
  if (request.reset) return {scope:memory.scope,topics:{}};
  if (request.plans.some(plan=>plan.at!==undefined)) return {...memory,focus:undefined,prior:undefined,active:undefined};
  if (request.plans.some(plan=>plan.operation||plan.schedule)) return {scope:memory.scope,topics:{}};
  const topics = {...memory.topics};
  const previous = {...memory.previous};
  for (const topic of ["comparison","station","count","records","diagnosis"] as const) {
    const plans = request.plans.filter(plan=>topicOf(plan)===topic)
      .map(plan=>plan.readOnly===false?{...plan,readOnly:true,focus:false}:plan);
    if (topics[topic] && topics[topic].expiresAt <= now) delete topics[topic];
    if (previous[topic] && previous[topic].expiresAt <= now) delete previous[topic];
    if (plans.length) {
      const existing=topics[topic];
      if(existing && JSON.stringify(existing.plans.map(({focus,...plan})=>plan))!==
        JSON.stringify(plans.map(({focus,...plan})=>plan))) previous[topic]=existing;
      topics[topic]={plans,expiresAt:now+ttl};
    }
  }
  const focus=rememberRequest({...request,plans:request.plans.map(plan=>topicOf(plan)&&!plan.readOnly?{...plan,readOnly:true}:plan)},memory.focus,now);
  const prior=focus&&focus!==memory.focus?memory.focus??memory.prior:memory.prior;
  const active=request.plans.length===1?topicOf(request.plans[0]):request.plans.length?undefined:memory.active;
  return {scope:memory.scope,focus,prior:prior&&prior.expiresAt>now?prior:undefined,topics,previous,active,outcomes:memory.outcomes};
}

export function rememberOutcomes(request:Interpretation,memory:ContextMemory,now:number,
  answers:readonly {comparisonDelta?:number;diagnosticSignal?:boolean;source?:string}[]) {
  const next=rememberTopics(request,memory,now);
  const outcomes={...next.outcomes};
  for(const topic of Object.keys(outcomes) as Topic[]) {
    if(!next.topics[topic] || next.topics[topic].expiresAt<=now) delete outcomes[topic];
  }
  request.plans.forEach((plan,i)=>{
    const topic=topicOf(plan);
    const answer=answers[i];
    if(topic && next.topics[topic]) outcomes[topic]={at:now,state:answer &&
      (answer.source || answer.comparisonDelta!==undefined || answer.diagnosticSignal!==undefined)?"answered":"partial"};
  });
  return {...next,outcomes};
}
