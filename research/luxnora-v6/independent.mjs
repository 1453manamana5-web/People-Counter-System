// New goal orders, scopes and evidence combinations retained for final scoring.
const structures=[
  ["scope-before-diagnostics","今年の退場回数が昨年より多い理由を調べて。それから入口端末の未送信件数を教えて",["higher-premise","entrance-pending"]],
  ["setup-before-required","カメラの設置方法を教えて。そして出口の未同期は何件？",["setup","pending"]],
  ["freshness-before-suggestion","出口の未同期件数を教えて。それから改善案をまとめて",["pending","advice"]],
  ["no-implicit-unit","入口と出口の未同期件数を教えて。そのあと記録をCSVに書き出す方法を教えて",["entrance-pending","pending","export"]],
  ["count-and-causal","今いる人数を教えて。今年の入場回数が去年を下回った理由を調べて",["occupancy","reason"]],
  ["mixed-purpose-and-gaps","台帳の整合性を調べて。そしてオフライン運用はどうすればいい？",["ledger","offline"]],
  ["unknown-window","出口の未同期件数を午後だけで教えて",["no-pending-number"]],
  ["forbidden-with-explicit-action","出口端末の未同期件数を見て。それから今すぐ閉場して",["safe-hold"]],
];
const dialogues=[
  ["pending-then-stat",["出口端末の未同期件数を調べて","今日の入場回数を教えて","集計は午前に絞って"],["entries-am"]],
  ["correct-independent-target",["入口端末は何件未同期ですか","今年と去年の退場回数を比べて","出口端末の未送信件数を教えて"],["pending"]],
  ["am-then-denied",["年度比較で入場回数を調べて","比較は午前でお願い"],["forbidden"],true],
  ["redo-after-cancel",["入口と出口の未同期件数を教えて","やっぱりいい","それをもう一度詳しく確認して"],["clarify"]],
  ["two-independent-topics",["今日の退場回数の合計を教えて","出口端末の未送信件数は何件？","回数の方を午前に絞って"],["exits-am"]],
  ["condition-after-comparison",["今年の入場回数を教えて","去年は","今年と去年の入場回数を比較して。少なければ原因を確認して。入口端末の状態を調べて"],["past","conditional","entrance"]],
  ["with-role-correction",["入口の端末状態を確認して","出口の未同期件数は何件ですか？","同じ条件でもう一度確認して"],["pending"]],
  ["return-after-new-goal",["今年と前年の入場回数を比較して","比較を午後に変更して","出口の未同期件数を教えて","比較を午前に限定して"],["am"]],
];
export function independent() {
  const conditions=["current","stale","missing","malformed","forbidden","ambiguous-history","history-failure","test"];
  return [
    ...structures.map(([name,text,checks])=>[name,[text],checks,false]),
    ...dialogues,
  ].flatMap(([name,turns,check,revoke],k)=>Array.from({length:13},(_,i)=>({
    id:name+"-"+i,structure:name,turns,check,revoke:revoke??false,
    kind:conditions[(3*i+k)%conditions.length],i:i+101,
  })));
}
