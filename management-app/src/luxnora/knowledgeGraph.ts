import type {Evidence} from "./assistant";
import type {Experience} from "./memory";
import type {observeLedger, observeStations} from "./reasoning";

type Relation = "uses" | "reports-pending" | "reports-warning" | "summarized-by" | "has-experience";
type Link = {from:string; relation:Relation; to:string; source:"ledger"|"station"|"memory"; at?:number; certainty:"observed"|"reported"};
export function buildKnowledge(data: Evidence, ledger: ReturnType<typeof observeLedger>,
  stations: ReturnType<typeof observeStations>, experiences: Experience[] = []) {
  const scope = data.scope ?? data.day?.id ?? data.name;
  const links: Link[] = [];
  if (ledger.value) links.push({from:scope,relation:"summarized-by",to:"ledger",source:"ledger",at:ledger.to,certainty:"observed"});
  for (const row of stations) {
    const {side,station}=row.value;
    if (!station) continue;
    links.push({from:scope,relation:"uses",to:side,source:"station",at:row.observedAt,certainty:"reported"});
    if (row.quality === "current" && station.pending != null && station.pending > 0) {
      links.push({from:side,relation:"reports-pending",to:"ledger",source:"station",at:row.observedAt,certainty:"reported"});
    }
    if (station.alert && station.alert !== "none") {
      links.push({from:side,relation:"reports-warning",to:station.alert,source:"station",at:row.observedAt,certainty:"reported"});
    }
  }
  for (const item of experiences) {
    if (item.scope === scope && item.at<=data.now && item.expiresAt>data.now) {
      links.push({from:scope,relation:"has-experience",to:item.kind,source:"memory",at:item.at,certainty:"observed"});
    }
  }
  return {scope,links};
}
