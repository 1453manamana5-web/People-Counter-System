import type {Answer, Evidence, Target} from "./assistant";
import {capabilities, getCapability, searchCapabilities, type Capability, type ViewState} from "./capabilities";
import type {Interpretation, Plan} from "./language";

type ApplicationGoal = {kind:"guide"|"navigate"; entries:Capability[]; plan?:Plan};
const textOf=(raw:string)=>raw.normalize("NFKC").trim().replace(/[。?!]+$/,"");

export function applicationGoal(raw:string, view?:ViewState):ApplicationGoal|undefined {
  if(raw.length>320) return undefined;
  const text=textOf(raw);
  if (!text || /(?:しないで|しなくて|せんといて|やめて|取り消|キャンセル|戻して)/.test(text)) return undefined;
  // Navigation accepts a single explicit request. Search scores never authorize a write or a view change.
  const move=/^(?:(入場|退場)(?:の)?(?:通過)?記録(?:だけ)?|設定画面|新規イベント(?:の)?(?:作成|下書き)(?:画面|フォーム)|受付端末画面)(?:を|に|へ)?(?:開いて|表示して|移動して)(?:ください)?$/.exec(text);
  if (move) {
    const id=move[1]?"records":text.startsWith("設定")?"access":text.startsWith("受付")?"station.health":"event.create";
    const entry=getCapability(id)!;
    const plan:Plan|undefined=move[1]?{intent:"records",role:move[1]==="入場"?"in":"out",focus:true,readOnly:true}:undefined;
    return {kind:"navigate",entries:[entry],plan};
  }

  if (/^(?:このアプリで何ができる|どんな機能がある|何が使える)$/.test(text)) {
    return {kind:"guide",entries:capabilities.filter(entry=>["event.create","station.pair","analysis.summary","records"].includes(entry.id))};
  }
  if (/^(?:これは何|この画面は何のため|この機能は何のため)(?:にある)?$/.test(text)) {
    const id=view&&({home:"analysis.summary",analysis:"analysis.range",stations:"station.health",records:"records",
      event:"event.lifecycle",settings:"access"} as const)[view.page];
    return {kind:"guide",entries:id?[getCapability(id)!]:[]};
  }
  if (!/(?:どうやって|どうすれば|どこで|とは|作り方|やり方|方法|何のため|違い|何が違|切れたらどう|途切れたら|どこに置|どの位置|できる[？?]?)/.test(text)) return undefined;
  const ranked=searchCapabilities(text);
  if(!ranked.length) return undefined;
  const clear=ranked.length===1||ranked[0].score-ranked[1].score>=4;
  // Close results remain visible as choices and never navigate automatically.
  return {kind:"guide",entries:(clear?ranked.slice(0,1):ranked).map(item=>item.entry)};
}

export function canOpenTarget(target:Target, eventSelected:boolean, authorized:boolean, editing:boolean) {
  if(editing) return false;
  if(target==="new-event") return authorized;
  if(target==="settings") return true;
  return eventSelected&&["occupancy","graph","compare","event","records","stations","in","out"].includes(target);
}

export function matchesProposal(binding:{proposalScope?:string;proposalVersion?:number}|null,
  scope:string,version:number|undefined,canConfirm:boolean) {
  return canConfirm&&version!==undefined&&binding?.proposalScope===scope&&binding.proposalVersion===version;
}

export function fulfillApplication(goal:ApplicationGoal, evidence:Evidence, view?:ViewState):Answer[] {
  if(!goal.entries.length) return [{text:"どの画面について確認したいか教えてください。"}];
  if(goal.kind==="navigate") {
    const entry=goal.entries[0];
    const target=entry.target;
    if(target&&canOpenTarget(target,!!(evidence.day||evidence.scope&&evidence.scope.split("/")[0]),view?.ready===true,false)) {
      return [{text:entry.title+"の画面を開くリクエストです。",target,plan:goal.plan,source:entry.source}];
    }
  }
  if(goal.entries.length>2) {
    return [{text:"開催日の設定、受付端末の登録、来場傾向の分析、通過記録の確認ができます。どれを確認しますか？",
      source:"管理アプリの機能一覧"}];
  }
  return goal.entries.map(entry=>({text:entry.guide,source:entry.source}));
}

export function screenRequest(raw:string, view?:ViewState):Interpretation|undefined {
  const text=textOf(raw);
  if (/^(?:これ|この端末)(?:は)?大丈夫(?:そう)?$/.test(text)&&view?.page==="stations") {
    return view.stationRole ? {plans:[{intent:"stations",role:view.stationRole,readOnly:true,focus:false}]} :
      {plans:[],message:"どの端末を確認しますか？ 入口か出口を指定してください。"};
  }
  if (/^(?:ここ|この時刻|この時点)(?:は|で|に)?何人(?:いた|いる|ですか)?$/.test(text)&&view?.page==="analysis") {
    return view.chartAt===undefined ? {plans:[],message:"グラフで時刻を選んでから聞いてください。"} :
      {plans:[{intent:"occupancy",at:view.chartAt,readOnly:true,focus:false}]};
  }
  return undefined;
}

export function extractAdvice(raw:string) {
  if(raw.length>320) return undefined;
  const match=/^(.*?)(?:[。!?、；;]\s*)(?:来年の|次回の)?(?:運営の)?改善(?:点|案)(?:を)?(?:まとめて|教えて)(?:ください)?[。!?]*$/s.exec(raw.normalize("NFKC"));
  return match?.[1].trim();
}

export function groundedAdvice(request:Interpretation, evidence:Evidence, answers:Answer[]):Answer {
  const diagnostics=request.plans.some(plan=>plan.intent==="issues"||plan.intent==="stations");
  const signal=diagnostics&&answers.some(row=>row.diagnosticSignal===true);
  const source=getCapability(signal?"station.health":"station.setup")!;
  const text=signal?
    "次回は、今回指摘された端末状態と未同期件数を開場前・閉場後の両方で確認し、現地で試験通過を行ってください。":
    "次回は開場前に正方向・逆方向・横並びの試験通過を行い、閉場後は会場が空になったことと未同期件数を確認してください。"+
      (!diagnostics||!evidence.current?" 今回の異常の有無は取得済みの情報だけでは断定できません。":"");
  return {text,source:source.source};
}
