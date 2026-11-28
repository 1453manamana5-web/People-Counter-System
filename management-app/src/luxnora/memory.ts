export type ExperienceKind = "ledger-recount" | "history-unavailable";
export type Experience = {
  kind: ExperienceKind; at: number; expiresAt: number; repeats: number;
  source: "local-verification"; scope: string;
};
type Profile = "auto" | "swift";
type Store = {profile?: Profile; experiences: Experience[]};
const ttl = 30 * 86_400_000;
const storageKey = (operator: string, scope: string) => "pcs-lux-v4:"+JSON.stringify([operator,scope]);

export function loadMemory(storage: Storage, operator: string, scope: string, now: number): Store {
  try {
    const value = JSON.parse(storage.getItem(storageKey(operator,scope)) ?? "{}");
    const experiences: Experience[] = Array.isArray(value?.experiences) ? value.experiences.filter((item: Experience) =>
      item && (item.kind === "ledger-recount" || item.kind === "history-unavailable") &&
      item.source === "local-verification" && item.scope === scope && Number.isFinite(item.at) && item.at <= now &&
      Number.isFinite(item.expiresAt) && item.expiresAt > now && item.expiresAt <= item.at+ttl &&
      Number.isSafeInteger(item.repeats) && item.repeats >= 1 && item.repeats <= 999).slice(0,8).map(({kind,at,expiresAt,repeats}:Experience)=>
        ({kind,at,expiresAt,repeats,source:"local-verification",scope})) : [];
    return {profile:value?.profile==="auto"||value?.profile==="swift"?value.profile:undefined,experiences};
  } catch {
    return {experiences:[]};
  }
}

export function saveProfile(storage: Storage, operator:string, scope:string, profile:Profile, now:number) {
  const memory = loadMemory(storage,operator,scope,now);
  storage.setItem(storageKey(operator,scope),JSON.stringify({...memory,profile}));
}

export function rememberExperience(storage: Storage, operator:string, scope:string, kind:ExperienceKind, now:number) {
  const memory = loadMemory(storage,operator,scope,now);
  const previous = memory.experiences.find(item=>item.kind===kind);
  // Coalesce repeat observations from one incident instead of counting prompts.
  if (previous && now-previous.at < 30*60_000) return;
  const item:Experience = {kind,at:now,expiresAt:now+ttl,repeats:Math.min(999,(previous?.repeats??0)+1),
    source:"local-verification",scope};
  storage.setItem(storageKey(operator,scope),JSON.stringify({...memory,
    experiences:[item,...memory.experiences.filter(old=>old.kind!==kind)].slice(0,8)}));
}

export function clearMemory(storage: Storage, operator:string, scope:string) {
  storage.removeItem(storageKey(operator,scope));
}
