import type {SeriesAndDays} from "../counterEvents";
import {fiscalYear, type ComparisonDay, type ComparisonWindow} from "../counterComparisonMetrics";
import type {Day} from "../counterLifecycle";
import type {Plan} from "./language";
import type {Answer} from "./assistant";

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
