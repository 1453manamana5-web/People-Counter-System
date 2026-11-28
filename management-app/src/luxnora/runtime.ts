import {answer, type Evidence} from "./assistant";
import {interpret, type Intent, type Interpretation, type Plan} from "./language";

export type Profile = "auto" | "swift";
export type Conversation = {plan: Plan; expiresAt: number};
type SemanticReader = (text: string) => Promise<Intent | null>;

const semanticIntents = new Set<Intent>([
  "occupancy", "entries", "exits", "dwell", "stations", "issues", "forecast",
  "briefing", "readiness", "compare", "graph", "records",
]);
const explicitOperation = /^(?:今すぐ|今から)?(開場|閉場)して(?:ください|もらえますか)?$/;
const explicitSchedule = /^(開場|閉場)(?:予定(?:時刻)?|時刻|時間)を(?:午前|午後)?\d{1,2}(?:時(?:半|[0-5]?\d分)?|:[0-5]\d)に(?:変更して|変えて|設定して)(?:ください)?$/;

export async function resolveRequest(
  raw: string,
  context: Conversation | undefined,
  now: number,
  profile: Profile,
  readSemantic: SemanticReader,
): Promise<Interpretation> {
  const previous = context && now < context.expiresAt ? context.plan : undefined;
  const result = interpret(raw, previous);
  const unique = new Map(result.plans.map(plan => [JSON.stringify(plan), plan]));
  const directive = raw.normalize("NFKC").replace(/\s/g, "").replace(/[。!?]+$/, "");
  if (result.plans.some(plan => plan.operation || plan.schedule)) {
    const [plan] = result.plans;
    const operation = explicitOperation.exec(directive)?.[1];
    const schedule = explicitSchedule.exec(directive)?.[1];
    if (result.plans.length === 1 && plan.intent === "event" && !plan.readOnly &&
      ((plan.operation && operation === (plan.operation === "open" ? "開場" : "閉場")) ||
      (plan.schedule && schedule === (plan.schedule.field === "start" ? "開場" : "閉場")))) return result;
    return {plans: [], message: "開場・閉場や予定変更の候補は、対象と操作を一件ずつ指定してください。"};
  }
  result.plans = [...unique.values()];
  if (profile !== "auto" || result.plans.length || result.reset || !result.message?.startsWith("依頼の対象")) return result;

  // Do not drop constraints when a whole-query embedding supplies only an intent.
  if (/[\d、,；;。!?\n年月日]|午前|午後|入口|出口|だけ|比べ|変更|設定|開場|閉場|しない|しなく|せず|せん|やめ/.test(raw.normalize("NFKC").trim().replace(/[。!?]+$/, ""))) return result;
  const intent = await readSemantic(raw).catch(() => null);
  if (!intent || !semanticIntents.has(intent)) return result;
  return {plans: [{intent, focus: /見せ|表示|確認|開い|調べ|移動/.test(raw), readOnly: true}]};
}

export function executeRequest(request: Interpretation, evidence: Evidence) {
  return request.plans.map(plan => answer(plan, evidence));
}

export function rememberRequest(request: Interpretation, previous: Conversation | undefined, now: number): Conversation | undefined {
  if (request.reset || request.plans.length > 1) return undefined;
  const [plan] = request.plans;
  if (!plan) return previous;
  if (plan.intent === "event" || plan.intent === "routine") return undefined;
  return {plan, expiresAt: now + 5 * 60_000};
}
