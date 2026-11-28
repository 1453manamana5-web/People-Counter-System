import {interpret, type Interpretation, type Plan} from "./language";
import {rememberRequest, type Conversation} from "./runtime";

const ttl = 5 * 60_000;
type Topic = "comparison" | "station";
type TopicMemory = {plans: Plan[]; expiresAt: number};
export type ContextMemory = {focus?: Conversation; topics: Partial<Record<Topic, TopicMemory>>};

export function recallCorrection(raw: string, memory: ContextMemory, now: number): Interpretation | undefined {
  const text = raw.normalize("NFKC").replace(/\s|[。?!]/g, "");
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
  return {focus:rememberRequest(request,memory.focus,now), topics};
}
