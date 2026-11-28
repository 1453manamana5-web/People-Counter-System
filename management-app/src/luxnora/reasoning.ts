import type {Evidence} from "./assistant";
import type {Plan} from "./language";

type Quality = "current" | "partial" | "missing";
export type Observation<T> = {
  source: "ledger" | "station";
  scope: string;
  evaluatedAt: number;
  observedAt?: number;
  from?: number;
  to?: number;
  quality: Quality;
  value: T;
};
export type LedgerCheck = {entries: number; exits: number; occupancy: number; consistent: boolean; pending: number; recent?: {entries: number; preceding: number}; issues: string[]};

export function observeLedger(data: Evidence): Observation<LedgerCheck | undefined> {
  const analysis = data.analysis;
  const from = data.config?.opened;
  const to = Math.min(data.now, data.config?.closed ?? data.now);
  const scope = data.scope ?? data.day?.id ?? data.name;
  const provenance = {source: "ledger" as const, scope, evaluatedAt: data.now, from: from ?? undefined, to};
  if (!analysis || from == null || !Number.isFinite(from) || !Number.isFinite(to) || from > to ||
      (data.config?.closed != null && data.config.closed > data.now)) {
    return {...provenance, quality: "missing", value: undefined};
  }
  // Recount reconciled rows independently of the aggregate and its timeline.
  let entries = 0, exits = 0, recent = 0, preceding = 0;
  const quarter = 15 * 60_000;
  const changes = new Map<number,number>();
  for (const row of analysis.effective) {
    if (row.invalid || row.person !== "visitor" || !Number.isFinite(row.at) || row.at < from || row.at > to) continue;
    if (row.direction !== "in" && row.direction !== "out") continue;
    changes.set(row.at, (changes.get(row.at) ?? 0) + (row.direction === "in" ? 1 : -1));
    if (row.direction === "in") {
      entries++;
      if (row.at > to - quarter) recent++;
      else if (row.at > to - 2 * quarter) preceding++;
    }
    if (row.direction === "out") exits++;
  }
  const occupancy = entries - exits;
  let reconstructed = 0;
  let previous = -Infinity;
  const timelineMatches = analysis.timeline.length === changes.size && analysis.timeline.every(point => {
    const delta = changes.get(point.at);
    if (delta === undefined || point.at <= previous) return false;
    previous = point.at;
    reconstructed += delta;
    return point.occupancy === reconstructed;
  });
  const consistent = timelineMatches && analysis.entries === entries && analysis.exits === exits &&
    analysis.occupancy === occupancy ;
  return {...provenance, quality: data.current && analysis.pending === 0 && consistent ? "current" : "partial",
    value: {entries, exits, occupancy, consistent, pending: analysis.pending,
      recent: to - from >= 2 * quarter ? {entries:recent, preceding} : undefined,
      issues: [...new Set(analysis.issues.map(issue => issue.code))]}};
}

export function observeStations(data: Evidence, role: Plan["role"]) {
  return (["in", "out"] as const).filter(side => !role || side === role).map(side => {
    const station = data.stations.find(row => row.mode === data.mode && row.status === "approved" && row.role === side);
    const seen = station?.lastSeen;
    const quality: Quality = !station ? "missing" : (data.stationsFromServer ?? data.current) && seen != null && seen <= data.now &&
      data.now - seen <= 180_000 ? "current" : "partial";
    return {source: "station", scope: data.scope ?? data.day?.id ?? data.name, evaluatedAt: data.now,
      observedAt: seen ?? undefined, quality, value: {side, station}} satisfies Observation<unknown>;
  });
}

type Hypothesis = {label: string; supporting: string[]; opposing: string[]; missing: string[]};

export function investigate(ledger: ReturnType<typeof observeLedger>, stations: ReturnType<typeof observeStations>) {
  const facts: string[] = [];
  const hypotheses: Hypothesis[] = [];
  const counts = ledger.value;
  if (counts?.consistent && counts.occupancy >= 0) facts.push(
    (ledger.quality === "current" ? "取得記録" : "取得済みの暫定記録")+"では、入場 "+counts.entries+"回、退場 "+counts.exits+"回、差し引き "+counts.occupancy+"人。");
  else facts.push(counts ? "台帳と集計の整合性を確認できなかったため、人数の判断を保留します。" : "開催日の台帳を取得できていません。");
  if (counts?.issues.length) facts.push("台帳の指摘は「"+counts.issues.join("」「")+"」です。");
  if (counts?.pending) facts.push("台帳上の未同期記録が "+counts.pending+"件あります。");
  for (const {quality, value: {side, station}} of stations) {
    const label = side === "in" ? "入口" : "出口";
    if (!station || quality !== "current") facts.push(label+"は現在の端末状態を確認できません。");
    if (!station) continue;
    const pending = station.pending;
    hypotheses.push({
      label: label+"の記録が集計に反映されていない可能性",
      supporting: [...(pending != null && pending > 0 ? [label+"の報告に未同期 "+pending+"件"] : []),
        ...(station.alert === "network" ? ["端末に通信の警告"] : [])],
      opposing: quality === "current" && pending === 0 && station.alert === "none" ? ["最新の端末報告は未同期0件"] : [],
      missing: ["再同期後の台帳と人数の変化"],
    });
    if (station.camera === false || station.ai === false || station.alert === "camera") {
      hypotheses.push({label: label+"で計測が欠けた可能性",
        supporting: [quality === "current" ? "端末にカメラまたは認識の停止・異常報告" : "取得済みの端末報告にカメラまたは認識の停止・異常"], opposing: [],
        missing: ["停止中の通過有無と現地の試験結果"]});
    }
  }
  if (counts?.issues.some(code => /重複|同時刻|滞在人数が負|閉場時の入退場数不一致/.test(code))) {
    hypotheses.push({label: "欠損・重複・時刻差を確認する必要があります",
      supporting: ["台帳に計測の整合性に関する指摘"], opposing: [],
      missing: ["指摘時刻の端末記録と現地の通過状況"]});
  }
  const recent = counts?.recent;
  if (recent && ledger.quality === "current" && !counts.issues.length && recent.entries > recent.preceding) {
    hypotheses.push({label:"来場ペース自体が上がった可能性",
      supporting:["直近15分の入場 "+recent.entries+"回、その前の15分は "+recent.preceding+"回"],
      opposing:[], missing:["両時間帯の現地状況と計測条件"]});
  }
  const supported = hypotheses.filter(item => item.supporting.length > 0);
  const rebutted = hypotheses.flatMap(item => item.opposing);
  const summary = supported.map(item => item.label+"。根拠は"+item.supporting.join("、")+"。確認に必要なのは"+item.missing.join("、")+"です。");
  return {facts, hypotheses, disposition: !counts?.consistent || ledger.quality !== "current" ? "defer" :
    supported.length || counts.issues.length ? "qualified" : "answer",
    text: [...facts, ...summary, ...(rebutted.length ? [rebutted.join("。")+"。"] : []), supported.length ? "報告時刻や件数だけでは原因を確定できません。" :
      "確認できた情報から原因は特定できません。"].join("\n")};
}
