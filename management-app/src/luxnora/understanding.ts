import {contextualRevision, recallCorrection, type ContextMemory} from "./context";
import {interpret, type Dependency, type Interpretation, type Plan} from "./language";
import {resolveRequest, type Profile} from "./runtime";

const readPlan = (intent:Plan["intent"], fields:Partial<Plan>={}):Plan => ({intent,focus:false,readOnly:true,...fields});
const restriction = /^(?:設定(?:は|を)(?:何も)?(?:変え|変更し)(?:なくていい|ないで|ない)|開場しないままで|閉場しないままで|閲覧だけで|(?:端末|カメラ)(?:を|は)再起動(?:しないで|せずに)|(?:入口|出口)(?:は|を)(?:確認|調査)しなくていい|(?:入口|出口)(?:は|を)調べなくていい)(?:ください|から|ね)?$/;
const refusal = /^(?:それは|それ|もう)?(?:せんといて|やらんといて|やめといて|やらないで|しないで)(?:ください)?$/;
const condition = /^(?:前年より|去年より)?(?:少な(?:かったら|ければ)|下回(?:ったら|れば))(?:、)?(?:原因|理由)(?:を)?(?:調べて|確認して|教えて)(?:ください)?$/;
const diagnose = /^(?:もし)?(?:問題|異常)(?:が)?(?:あったら|あれば|見つかったら)(?:、)?(?:原因|理由)(?:を)?(?:調べて|確認して|教えて)(?:ください)?$/;

function normalize(text:string) {
  return text.normalize("NFKC").trim().replace(/どんくらい|どんぐらい/g,"どのくらい")
    .replace(/おかしない|おかしゅうない/g,"おかしい").replace(/比べたら(?=[?。!]|$)/g,"比べて")
    .replace(/^そろそろ(?=混む|混み|空く)/,"この後")
    .replace(/だけ確認して$/, "だけ教えて");
}

function directRead(text:string):Plan[]|undefined {
  if (/^(?:今|現在)(?:の)?(?:どんな感じ|どういう状況|どんな状況)$/.test(text)) return [readPlan("briefing")];
  if (/^人数(?:を)?(?:確認して|調べて)$/.test(text)) return [readPlan("occupancy")];
  if (/^(?:今日)?どのくらい(?:来はった|来た)(?:ん|の)?$/.test(text)) return [readPlan("entries")];
  if (/^(?:入口|出口)(?:の方|のほう)?(?:おかしい|変な感じ)(?:の|ん)?$/.test(text)) {
    return [readPlan("stations",{role:text.startsWith("入口")?"in":"out"})];
  }
  if (/^(?:去年|前年|昨年)の方が多かった気がする$/.test(text)) {
    return [readPlan("compare",{previousYear:true,compareDifference:true,comparisonMetric:"entries"})];
  }
  return undefined;
}
function readClause(text:string, previous?:Plan):Plan[] {
  return directRead(text) ?? interpret(text.replace(/(状態|調子)も調べて$/,"$1を調べて"),previous)
    .plans.filter(plan=>!plan.operation&&!plan.schedule&&plan.intent!=="event"&&plan.intent!=="routine")
    .map(plan=>({...plan,readOnly:true}));
}

function ambiguity(text:string, previous?:Plan):Interpretation|undefined {
  if (/^(?:なんか)?減ってきた(?:な|ね)?$/.test(text)) {
    return previous?.intent==="occupancy"&&previous.period===undefined?{plans:[readPlan("trend")]}:
      {plans:[],message:"今の滞在人数と来場ペースのどちらの変化を確認しますか？"};
  }
  if (/^(?:これ大丈夫そう|そっちもお願い)$/.test(text)) {
    return text.startsWith("これ")&&previous?.intent==="stations"?
      {plans:[{...previous,readOnly:true}]}:
      {plans:[],message:"どの端末や記録について確認しますか？"};
  }
  if (/^(?:今日(?:は|、)?(?:人|人数|来場者)(?:が)?多い|(?:人数|人)(?:が)?減って(?:きたな|ない))$/.test(text)) {
    const recent = previous?.intent==="occupancy" && previous.period===undefined;
    if (recent && text.includes("減って")) return {plans:[readPlan("trend")]};
    return {plans:[],message:"何と比べますか？ 今の滞在人数、直前の来場ペース、前年の入場回数を確認できます。"};
  }
  if (/^(?:入口|出口)の数字が気になる$/.test(text)) {
    return {plans:[],message:"端末の状態と、入退場記録の整合性のどちらを確認しますか？"};
  }
  return undefined;
}

function structured(text:string, previous?:Plan):Interpretation|undefined {
  const clauses=text
    .replace(/^(?:今から|今すぐ)?(?:開場|閉場)して[、,]?(?:ではなく|じゃなく)[、,]?(?=.+)/,
      "閲覧だけで。")
    .replace(/((?:閲覧|確認|調査)だけ)で[、,]/g,"$1で。")
    .replace(/((?:確認して|調べて|比べて|教えて|見せて))、(?=入口|出口|端末|去年|前年|少な|下回|問題|異常|設定)/g,"$1。")
    .replace(/^((?:開場|閉場)しないままで)、/,"$1。")
    .split(/[。!?；;\n]+/).map(clause=>clause.trim()).filter(Boolean);
  const hasRestriction=clauses.some(clause=>restriction.test(clause));
  if (!hasRestriction&&!clauses.some(clause=>condition.test(clause)||diagnose.test(clause))) return undefined;
  if (clauses.length>6) return {plans:[],message:"条件と確認したい項目を分けて入力してください。"};

  const plans:Plan[]=[];
  const dependencies:Dependency[]=[];
  for (const clause of clauses) {
    if (restriction.test(clause)) continue;
    const lower=condition.test(clause);
    const issue=diagnose.test(clause);
    if (lower||issue) {
      const after=lower?plans.map(plan=>!!(plan.intent==="compare"&&plan.previousYear&&plan.compareDifference)).lastIndexOf(true):
        plans.map(plan=>plan.intent==="stations"||plan.intent==="issues").lastIndexOf(true);
      if(after<0) return {plans:[],message:"先に比較する記録、または異常を確認する端末を指定してください。"};
      dependencies.push({after,task:plans.length,when:lower?"previous-year-lower":"anomaly"});
      plans.push(readPlan("issues",{period:plans[after].period,role:plans[after].role}));
      continue;
    }
    if (/設定|削除|権限|開場して|閉場して|再起動|停止して|しないで|しなく|せんといて/.test(clause)) {
      return {plans:[],message:"操作を含む場合は、確認したい項目と分けて指定してください。"};
    }
    const excluded=clauses.find(part=>/^(?:入口|出口)(?:は|を)(?:調べ|確認し|調査し)なくていい$/.test(part));
    const complement=excluded&&/^(入口|出口)だけ(?:でお願い|を確認して|でいい)$/.exec(clause);
    const found=complement&&complement[1]!==excluded?.slice(0,2)?
      [readPlan("stations",{role:complement[1]==="入口"?"in":"out"})]:readClause(clause,plans.at(-1)??previous);
    if(!found.length) return {plans:[],message:"依頼の一部を特定できません。確認したい項目を分けて教えてください。"};
    plans.push(...found);
  }
  if(plans.length>4) return {plans:[],message:"一度に4件まで確認できます。"};
  return {plans,dependencies,constraints:{readOnly:true},
    message:plans.length?undefined:"確認したい項目を教えてください。"};
}

export async function resolveLanguage(raw:string, memory:ContextMemory, now:number, profile:Profile,
  semantic:Parameters<typeof resolveRequest>[4]):Promise<Interpretation> {
  if(raw.length>320) return resolveRequest(raw,memory.focus,now,"swift",semantic);
  const text=normalize(raw);
  const bare=text.replace(/[。!?]+$/,"");
  const previous=memory.focus&&memory.focus.expiresAt>now?memory.focus.plan:undefined;
  const cancellation=recognizeCancellation(raw);
  if(cancellation) return cancellation;
  const correction=contextualRevision(bare,memory,now) ?? recallCorrection(bare,memory,now);
  if(correction) return correction;
  const ambiguous=ambiguity(bare,previous);
  if(ambiguous) return ambiguous;
  const semanticStructure=structured(text,previous);
  if(semanticStructure) return semanticStructure;
  // Use the prior parser and its strict operation guard for the normal route.
  const local=directRead(bare);
  if(local) return {plans:local,constraints:{readOnly:true}};
  return resolveRequest(text,memory.focus,now,profile,semantic);
}

export function recognizeCancellation(raw:string):Interpretation|undefined {
  if(raw.length>320) return undefined;
  if(refusal.test(raw.normalize("NFKC").trim().replace(/[。!?]+$/,""))) {
    return {plans:[],reset:true,message:"依頼を取り消しました。"};
  }
  if(!/取り消|キャンセル|やっぱりいい|なしで/.test(raw)) return undefined;
  const result=interpret(raw);
  return result.reset?result:undefined;
}
