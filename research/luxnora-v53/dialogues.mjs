// Split-specific utterances and dialogue structures. Labels are authored
// alongside the intended dialogue act and never inferred from Core's output.
export const topics=["comparison","station","count","records","diagnosis","clarify"];
export const intentTopic={compare:"comparison",stations:"station",occupancy:"count",entries:"count",
  exits:"count",records:"records",issues:"diagnosis",dwell:"count",crowd:"count"};
const sections={
  train:{
    seeds:[
      ["今年と去年の来場者数を比べて","本年と前年の退場回数の差を教えて","年度比較で人数の差を出して","昨年と今年の入場数に差があるか比べて"],
      ["出口端末の状態を見て","入口の端末は正常？","受付端末の未同期を確認して","両端末の接続状況を確認して"],
      ["本日の累計入場回数を教えて","いま会場内に何人いる？","今日の退場回数は何回？","今日の入場は何人？"],
      ["入場の履歴を見せて","出口の通過記録を教えて","全体の通過ログを表示して","今日の退場記録一覧を見せて"],
      ["台帳の数字の整合性を調べて","計測記録の誤差を調べて","集計の矛盾を洗い出して","人数と記録が合わない原因を調べて"],
    ],
    explicit:["比較の件は午後だけに変更して","端末をもう一度確認して","集計は午前でお願い","履歴は午後に絞って","診断をもう少し詳しく"],
    generic:["同じ条件でもう一度確認して","もう少し詳しく","そのまま続けて","さっきと同じで、もう一度調べて","改めて見せて"],
    structures:["focus","interruption","return","ambiguous","reset","four","reset-gap","repeat"],
  },
  validation:{
    seeds:[
      ["前年の入場回数と今年を比較して","昨年との来場回数はどれほど違う？","退場回数の前年比を調べて"],
      ["出口のカメラは正常に動いてる？","入口の同期状態の確認をお願いします","入口と出口の端末は繋がってる？"],
      ["室内に残っている人は何名？","きょうの累計入場を教えて","今日帰った人はどのくらい？"],
      ["入場記録の一覧を表示して","退場のログを見せて","通過した履歴を調べて"],
      ["集計と台帳の不一致を調べて","通過記録に計測漏れがないか調べて","人数の数え間違いがないか診断して"],
    ],
    explicit:["年度比較を午前の分でお願い","端末の方を改めて調べて","回数は午後だけでいい","記録の方を午前に限定して","原因を改めて確認して"],
    generic:["もっと詳しく見せて","同じ条件でもう一度お願い","そのまま調べてください","もうちょっと詳しくお願い"],
    structures:["focus","interruption","return","ambiguous","reset","five"],
  },
  independent:{
    seeds:[
      ["去年の入場と今日の入場でどれだけ違う？","昨年度と本年度の来場回数にどれほど差がある？","今年と前年を退出回数で比較できる？"],
      ["出口側の受付がちゃんと稼働してるか確認して","両端末はオンラインですか","入口側のカメラが止まってないか見て"],
      ["展示室内にはいま何人おる？","今日入った人の合計はいくつ？","会場から出たのは延べ何人？"],
      ["通った履歴のうち退出を見たい","通過ログから入場した記録を見せて","入退場の記録一覧を確認できますか"],
      ["この計測の数字は信用できるか調べて","データが矛盾してる原因を確認して","記録の数字が合わへん。整合性を調べて"],
    ],
    explicit:["その差は午後の分でお願い","端末についてもう一度調べて","人数の集計は午前に限定して","通過履歴は終日でお願い","原因の方をもうちょっと詳しく"],
    generic:["もう一度詳しく確認して","さっきと同じ条件でお願い","改めて詳しく調べて","そのまま続けてください"],
    structures:["focus","interruption","return","ambiguous","reset","long"],
  },
};
export function buildDialogues(split, count) {
  const {seeds,explicit,generic,structures}=sections[split];
  const pool=new Map();
  const add=(structure, turns, expected, gold, goldActive=null)=>{
    const key=JSON.stringify(turns.map(t=>t.normalize("NFKC").replace(/\s/g,"")));
    if(!pool.has(key)) pool.set(key,{structure,turns,expected,gold,goldActive});
  };
  for(let i=0;i<5;i++) for(let j=0;j<5;j++) {
    if(i===j) continue;
    for(const a of seeds[i]) for(const b of seeds[j]) for(const g of generic) {
      for(const kind of structures) {
        const first=topics[i], second=topics[j];
        const pair=a+"。"+b;
        const both=[first,second];
        if(kind==="focus") add(kind,[a,g,g===generic[0]?generic[1]:generic[0]],first,[first],first);
        if(kind==="interruption") add(kind,[a,b,explicit[i]],first,both,second);
        if(kind==="return") add(kind,[a,b,explicit[i],g],first,both,first);
        if(kind==="ambiguous") add(kind,[a,pair,g],"clarify",both);
        if(kind==="reset") add(kind,[a,b,"キャンセルして",g],"clarify",[]);
        if(kind==="reset-gap") add(kind,[a,"やっぱりいい",g],"clarify",[]);
        if(kind==="repeat") add(kind,[a,b,g,explicit[i],g],first,both,first);
        if(kind==="four") add(kind,[a,b,explicit[i],explicit[j]],second,both,first);
        if(kind==="five") add(kind,[a,b,g,explicit[i],explicit[j]],second,both,first);
        if(kind==="long") add(kind,[a,b,g,explicit[i],g,explicit[j],g,a,b,explicit[i],g],first,both,first);
      }
    }
  }
  let random=split==="train"?53001:split==="validation"?53002:53003;
  const next=()=>{random=(1664525*random+1013904223)>>>0;return random;};
  const grouped=structures.map(kind=>[...pool.values()].filter(row=>row.structure===kind));
  for(const rows of grouped) for(let i=rows.length-1;i>0;i--) {
    const j=next()%(i+1);
    [rows[i],rows[j]]=[rows[j],rows[i]];
  }
  const selected=[];
  while(selected.length<count) {
    let grew=false;
    for(const rows of grouped) if(rows.length&&selected.length<count) {selected.push(rows.pop());grew=true;}
    if(!grew) throw Error("Requested dialogues exceed authored structures");
  }
  return selected;
}
