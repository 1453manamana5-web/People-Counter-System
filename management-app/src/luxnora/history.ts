import type {SeriesAndDays} from "../counterEvents";
import {fiscalYear, type ComparisonDay, type ComparisonWindow} from "../counterComparisonMetrics";
import type {Day} from "../counterLifecycle";
import type {Plan} from "./language";
import {luxRange, type Answer, type Evidence} from "./assistant";
import type {LedgerCheck, Observation} from "./reasoning";

export function previousYearDay(catalog: SeriesAndDays | null, day: Day) {
  const year = fiscalYear(day.date) - 1;
  const candidates = catalog?.days.filter(candidate =>
    candidate.eventId === day.eventId && fiscalYear(candidate.date) === year &&
    candidate.finalized != null && candidate.ended != null) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function previousYearWindow(period: Plan["period"], date: string): ComparisonWindow | undefined {
  if (period === undefined || typeof period === "number") return undefined;
  const midnight = Date.parse(date+"T00:00:00+09:00");
  const minutes = typeof period === "object" ? period : period === "am" ? {from:0,to:720} : {from:720,to:1440};
  return {from:midnight+minutes.from*60_000, to:midnight+minutes.to*60_000};
}

export function previousYearAnswer(plan: Plan, summary: ComparisonDay | undefined): Answer {
  if (summary?.status !== "verified" || summary.issues || summary.duration <= 0) {
    return {target:"compare", text:"前年の確定記録を確認できませんでした。年度比較画面から対象日と通信状態を確認してください。"};
  }
  const counts = plan.period === undefined ? summary : summary.window;
  if (!counts || counts.duration <= 0) {
    return {target:"compare", text:summary.date+"は指定時間帯と開場時間が重なっていません。"};
  }
  const label = plan.period === "am" ? " 午前" : plan.period === "pm" ? " 午後" :
    typeof plan.period === "object" ? " 指定時間帯" : "";
  const exits = plan.comparisonMetric === "exits";
  return {target:"compare", text:summary.date+"（本番・確定）"+label+"の"+
    (exits ? "退場 "+counts.exits : "入場 "+counts.entries)+"回です。"};
}

export function verifiedComparison(plan: Plan, summary: ComparisonDay, evidence: Evidence,
  ledger: Observation<LedgerCheck | undefined>): Answer {
  const prior = previousYearAnswer(plan, summary);
  if (!plan.compareDifference || summary.status !== "verified" || summary.issues) return prior;
  const past = summary.bounds;
  const current = ledger.value;
  const mismatch = " 比較できる条件が揃っていないため、増減の判断は保留します。";
  if (!past || !current?.consistent || !evidence.sealed || current.pending || current.issues.length ||
      evidence.mode !== "live" || ledger.from == null || ledger.to == null || !evidence.analysis) {
    return {...prior, text:prior.text+mismatch};
  }
  const pastRange = luxRange(plan.period,past.from,past.to);
  const currentRange = luxRange(plan.period,ledger.from,ledger.to);
  const sameClock = (a: number, b: number) => (a-b)%86_400_000 === 0;
  if (pastRange.from >= pastRange.to || currentRange.from >= currentRange.to ||
      !sameClock(pastRange.from,currentRange.from) || !sameClock(pastRange.to,currentRange.to)) {
    return {...prior, text:prior.text+mismatch};
  }
  const direction = plan.comparisonMetric === "exits" ? "out" : "in";
  const pastCounts = plan.period === undefined ? summary : summary.window;
  if (!pastCounts) return {...prior, text:prior.text+mismatch};
  const previousCount = direction === "in" ? pastCounts.entries : pastCounts.exits;
  const currentCount = evidence.analysis.effective.filter(row => !row.invalid && row.person === "visitor" &&
    row.direction === direction && row.at >= currentRange.from &&
    (currentRange.untilExclusive ? row.at < currentRange.to : row.at <= currentRange.to)).length;
  const difference = currentCount - previousCount;
  return {...prior, comparisonDelta:difference, text:prior.text+" 同じ実開場時間帯の今回の確定記録は "+currentCount+
    "回で、記録上の差は "+(difference>0?"+":"")+difference+
    "回です。両日の計測方式や停止時間の差は確認できていません。"};
}
