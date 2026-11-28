import type {Answer, Evidence} from "./assistant";
import {getCapability, searchCapabilities, type Capability} from "./capabilities";
import type {Interpretation} from "./language";

// A bounded choice between local evidence providers and guidance. Operational
// requests stay on the normal intent/confirmation path.
export function countImprovement(raw:string,evidence:Evidence) {
  const text=raw.normalize("NFKC").trim();
  if(text.length>320 || /(?:削除|変更|設定|書き換|修正して|復元|再起動|解除|権限|閉場して|開場して|しない|しなく|調べなく|せんといて|ないで|取り消|キャンセル|停止して)/.test(text)) return undefined;
  const count=/計測|カウント|人数|数え/.test(text);
  const improve=/正確|ミス|間違|精度|改善|見直/.test(text);
  const review=/問題点?|見落と|原因|点検|洗い出/.test(text);
  if(!((count&&improve)||(review&&improve&&/運営|今年|今日/.test(text)))) return undefined;
  if(/天気|株価|レシピ|宿題|前年|去年|昨年|CSV|予測|あったら|なければ|分けて/i.test(text)) return undefined;

  const requiresFindings=review||/今年|今日|今回|前回/.test(text);
  const entrance=text.includes("入口"),exit=text.includes("出口");
  const role=entrance===exit?undefined:entrance?"in":"out";
  const candidates=[
    {request:{plans:[{intent:"issues",role,focus:false,readOnly:true}],constraints:{readOnly:true}} satisfies Interpretation,
      score:requiresFindings?(evidence.analysis?4:2):0},
    {request:{plans:[],constraints:{readOnly:true}} satisfies Interpretation,score:requiresFindings?1:3},
  ].sort((a,b)=>b.score-a.score);
  // Use the operation inventory to find feasible local setup references.
  const lookup=text+" 設置 通過試験 A B カメラ";
  const related=searchCapabilities(lookup,5).find(row=>row.entry.id==="station.setup")?.entry;
  return {request:candidates[0].request,guide:related??getCapability("station.setup")!,requiresFindings};
}

export function improvementAnswer(plan:NonNullable<ReturnType<typeof countImprovement>>,evidence:Evidence, answers:Answer[]):Answer {
  const alert=answers.some(answer=>answer.diagnosticSignal===true);
  const setup:Capability=plan.guide;
  const diagnostic=getCapability("station.health")!;
  const next=alert?"次回は、今回の端末報告で指摘のあった項目を見直し、試験通過の結果と未同期件数を確認してください。":
    "次回は、正方向・逆方向と横並びの試験通過で、数え方を確認してください。";
  const stale=plan.requiresFindings&&(!evidence.current||!evidence.analysis);
  return {text:next+" "+setup.guide+(stale?" 今回は利用できる記録が限られるため、異常の有無は断定できません。":""),
    source:alert?diagnostic.source+" / "+setup.source:setup.source};
}

export function followupAdvice(raw:string) {
  return /^(?:最後に|次回の|来年の|運営の)?(?:改善点|改善案)(?:を)?(?:教えて|まとめて)(?:ください)?[。?!]*$/
    .test(raw.normalize("NFKC").trim());
}
