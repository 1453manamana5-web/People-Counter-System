import {analyze} from "../../counter-app/public/people-counter/ledger.mjs";

const now=Date.parse("2026-11-28T15:00:00+09:00");
const opened=Date.parse("2026-11-28T09:00:00+09:00");
const previousStart=Date.parse("2025-11-28T09:00:00+09:00");
const eventId="fixture";
const day={id:"today",date:"2026-11-28",eventId,version:2};
const past={id:"past",date:"2025-11-28",eventId,version:1,ended:previousStart+6*3600000,finalized:previousStart+6*3600000};

export const variants=["current","stale","missing","malformed","forbidden","ambiguous-history","history-failure","test"];
export function fixture(kind, i=0) {
  const mode=kind==="test"?"test":"live";
  const out=i%2===0?4:7;
  const operation={id:"synthetic",eventId,mode,kind:"passage",at:opened+60000,direction:"in",
    person:"visitor",source:"manual",createdAt:opened+60000,note:"fixture",synced:true};
  const analysis=analyze([operation,{...operation,id:"synthetic-exit",at:opened+120000,direction:"out"}],{eventId,mode,opened,closed:now,now,verified:true});
  const lastSeen=kind==="stale"?now-240000:now;
  const evidence={scope:"today/"+mode,name:"模擬文化祭",mode,now,day,current:true,sealed:true,
    config:{opened,closed:now,paused:false,verified:true},stationsFromServer:true,analysis,ledgerFromServer:true,prediction:[],
    stations:[{mode,role:"in",name:"入口端末",status:"approved",lastSeen:now,pending:0,camera:true,ai:true,alert:"none"},
      ...kind==="missing"?[]:[{mode,role:"out",name:"出口端末",status:"approved",lastSeen,pending:kind==="malformed"?-8:out,
        camera:false,ai:true,alert:"camera"}],
      {mode:mode==="test"?"live":"test",role:"out",status:"approved",lastSeen:now,pending:999,camera:true,ai:true,alert:"none"}]};
  const snapshot={evidence,catalog:{days:kind==="ambiguous-history"?[past,{...past,id:"ambiguous"}]:[past]},
    view:{page:"home",ready:kind!=="forbidden"}};
  return {snapshot,out,history:kind==="history-failure"?undefined:{
    id:past.id,date:past.date,status:"verified",issues:0,duration:360,entries:8,exits:3,
    bounds:{from:previousStart,to:previousStart+6*3600000}}};
}

// Each goal structure is held out as a whole. Repeated conditions measure
// stability; they are counted separately from distinct goal structures.
const pending=["出口端末の未同期件数を教えて","出口の未送信は何件ありますか","出口側で同期できていない未同期記録は何件ですか"];
const guide={
  setup:["iPadの設置方法を教えて","試験通過のときiPadはどこに置けばいい？"],
  export:["通過記録の出力方法を教えて","記録をCSVに書き出す方法を教えて"],
};
const goal=[
  {id:"pending",turns:i=>[pending[i%3]],check:["pending"]},
  {id:"pending-plus-setup",turns:i=>[pending[i%3]+"。そして"+guide.setup[i%2]],check:["pending","setup"]},
  {id:"pending-plus-export",turns:i=>[pending[i%3]+"。そのあと"+guide.export[i%2]],check:["pending","export"]},
  {id:"pending-plus-ledger",turns:i=>[pending[i%3]+"。今日の入場回数を教えて"],check:["pending","entry"]},
  {id:"pending-plus-history",turns:i=>[pending[i%3]+"。今年と去年の入場回数を比較して"],check:["pending","past"]},
  {id:"why-fewer",turns:()=>["今年の入場回数が去年より少ない理由を調べて"],check:["reason"]},
  {id:"why-fewer-plus-pending",turns:i=>["今年の入場回数が去年より少ない理由を調べて。"+pending[i%3]],check:["reason","pending"]},
  {id:"condition-plus-independent",turns:()=>["今年と去年の入場回数を比較して。前年より少なかったら原因を調べて。出口の端末状態を教えて"],check:["past","conditional","exit"]},
  {id:"test-no-write",turns:()=>["端末を再起動しないで。出口の端末状態を確認して"],check:["exit"]},
  {id:"guide-plus-counts",turns:i=>["今日の入場と退場の回数をそれぞれ教えて。そのあと"+guide.export[i%2]],check:["entry","exit-count","export"]},
  {id:"comparison-edit",turns:()=>["今年と去年の入場回数を比べて","出口端末の状態を確認して","年度比較を午前だけに絞って"],check:["am"]},
  {id:"cancel-clears-scope",turns:()=>["今日の入場回数を教えて","依頼を取り消して","同じ条件でもう一度確認して"],check:["clarify"]},
  {id:"pending-after-camera",turns:i=>["出口端末の状態を確認して",pending[i%3]],check:["pending"]},
  {id:"comparison-and-return",turns:()=>["昨日の結果ではなく今年と去年の入場回数を比較して","出口端末の状態を確認して","比較の方を午後に修正して"],check:["pm"]},
  {id:"permission-change",turns:i=>["出口端末の状態を確認して",pending[i%3]],check:["forbidden"],revoke:true},
  {id:"pending-after-cancellation",turns:i=>["入口端末の状態を確認して","取り消して",pending[i%3]],check:["pending"]},
  {id:"topic-revisit",turns:()=>["今年と去年の入場回数を比較して","出口端末の状態を確認して","年度比較を午前だけに絞って","同じ条件でもう一度確認して"],check:["am"]},
  {id:"partial-after-why",turns:()=>["今年の入場回数が去年より少ない理由を調べて","出口端末の状態を確認して","同じ条件でもう一度確認して"],check:["exit"]},
];
export function cases() {
  return goal.flatMap((definition,index)=>Array.from({length:15},(_,i)=>{
    const kind=variants[(i+index)%variants.length];
    return {id:definition.id+"-"+i,structure:definition.id,i,kind,revoke:definition.revoke??false,
      turns:definition.turns(i),check:definition.check};
  }));
}
