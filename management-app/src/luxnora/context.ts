import {interpret, type Interpretation, type Plan} from "./language";
import {rememberRequest, type Conversation} from "./runtime";

const ttl = 5 * 60_000;
type Topic = "comparison" | "station";
type TopicMemory = {plans: Plan[]; expiresAt: number};
export type ContextMemory = {focus?: Conversation; prior?: Conversation; topics: Partial<Record<Topic, TopicMemory>>};

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
  if (request.reset) return {topics:{}};
  if (request.plans.some(plan=>plan.operation||plan.schedule)) return {topics:{}};
  const topics = {...memory.topics};
  for (const [topic,intent] of [["comparison","compare"],["station","stations"]] as const) {
    const plans = request.plans.filter(plan=>plan.intent===intent);
    if (plans.length) topics[topic] = {plans,expiresAt:now+ttl};
    else if (topics[topic] && topics[topic].expiresAt <= now) delete topics[topic];
  }
  const focus=rememberRequest(request,memory.focus,now);
  const prior=focus&&focus!==memory.focus?memory.focus??memory.prior:memory.prior;
  return {focus,prior:prior&&prior.expiresAt>now?prior:undefined,topics};
}
