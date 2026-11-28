import {useEffect,useRef,useState,type FormEvent} from "react";
import {watchAlerts,type Answer,type Evidence,type Target} from "./assistant";
import type {Plan} from "./language";
import {executeRequest,rememberRequest,resolveRequest,type Conversation,type Profile} from "./runtime";
import {bounded} from "../counterAuth";
import type {SeriesAndDays} from "../counterEvents";
import {previousYearAnswer,previousYearDay,previousYearWindow} from "./history";
import motionAsset from "./motion.svg?url";

export function LuxnoraPanel({evidence,catalog,focus,cancel}:{evidence:Evidence;catalog:SeriesAndDays|null;focus:(target:Target,plan?:Plan)=>void;cancel:()=>void}) {
  const [open,setOpen]=useState(false),[input,setInput]=useState("");
  const isOpen=useRef(false);
  const [motion,setMotion]=useState("idle");
  const [mounted,setMounted]=useState(false);
  const closeTimer=useRef<number|undefined>(undefined);
  const motionTimer=useRef<number|undefined>(undefined);
  useEffect(()=>()=>{clearTimeout(motionTimer.current);clearTimeout(closeTimer.current);},[]);
  function changeMotion(next:string,after:string,ms:number) {
    clearTimeout(motionTimer.current);
    setMotion(next);
    motionTimer.current=window.setTimeout(()=>setMotion(after),ms);
  }
  function changeOpen(next:boolean) {
    clearTimeout(closeTimer.current);
    isOpen.current=next;
    setOpen(next);
    changeMotion(next?"ignition":"convergence",next?"living":"idle",next?840:540);
    if(next) {setMounted(true);if(!window.matchMedia("(pointer: coarse)").matches) requestAnimationFrame(()=>prompt.current?.focus({preventScroll:true}));}
    else {
      trigger.current?.focus();
      if(window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMounted(false);
      else closeTimer.current=window.setTimeout(()=>setMounted(false),540);
    }
  }
  const [profile,setProfile]=useState<Profile>(()=>{
    try {return localStorage.getItem("counter-lux-profile")==="swift"?"swift":"auto";}catch{return "auto";}
  });
  const [notes,setNotes]=useState<{prompt:string;response:Answer[]}[]>([]);
  const [setting,setSetting]=useState(()=>{
    try {return localStorage.getItem("pcs-counter-lux-support")??"smart";}catch{return "smart";}
  }),[working,setWorking]=useState(false);
  const [monitor,setMonitor]=useState<{role?:Plan["role"];until:number}|null>(null);
  const [offered,setOffered]=useState<Plan|null>(null);
  const [activity,setActivity]=useState<string[]>([]);
  const monitorSnapshot=useRef("");
  useEffect(()=>{
    if(!monitor) return;
    if(Date.now()>=monitor.until){setMonitor(null);setActivity(rows=>[...rows.slice(-5),"見守り時間が終了しました。"]);return;}
    if(document.hidden) return;
    const alarms=watchAlerts(evidence,monitor.role),status=alarms.join("\n");
    if(status===monitorSnapshot.current) return;
    monitorSnapshot.current=status;
    setActivity(rows=>[...rows.slice(-3),...(alarms.length?alarms:["取得済みの端末に新たな注意はありません。"])].slice(-6));
  },[evidence,monitor]);
  const replies=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(replies.current) replies.current.scrollTop=replies.current.scrollHeight;},[notes,mounted,working]);
  const generation=useRef(0),inFlight=useRef(false);
  const historicalRead=useRef<AbortController|null>(null);
  useEffect(()=>()=>{generation.current++;inFlight.current=false;historicalRead.current?.abort();},[]);
  const previous=useRef<Conversation|undefined>(undefined);
  function cancelRequest() {
    generation.current++;
    historicalRead.current?.abort();
    historicalRead.current=null;
    inFlight.current=false;
    setWorking(false);
    previous.current=undefined;
    cancel();
    setOffered(null);
    setMonitor(null);
    if(isOpen.current) setMotion("living");
  }
  const latestEvidence=useRef(evidence);
  useEffect(()=>{latestEvidence.current=evidence;},[evidence]);
  const prompt=useRef<HTMLInputElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  function showWorking() {
    setWorking(true);
    clearTimeout(motionTimer.current);
    motionTimer.current=undefined;
    if(isOpen.current) setMotion("checking");
  }
  async function submit(event:FormEvent) {
    event.preventDefault();
    const text=input.trim();
    if(!text||inFlight.current) return;
    const requestId=++generation.current;
    inFlight.current=true;
    setOffered(null);
    cancel();
    const plan=await resolveRequest(text,previous.current,Date.now(),profile,async raw=>{
      showWorking();
      const {semanticRead}=await import("./semantic");
      return semanticRead(raw);
    });
    if(requestId!==generation.current) return;
    const snapshot=latestEvidence.current;
    const response=executeRequest(plan,snapshot);
    const lookup=plan.plans.findIndex(item=>item.intent==="compare"&&item.previousYear&&
      typeof item.period!=="number"&&item.comparisonMetric!=="occupancy");
    const selected=snapshot.day;
    if(lookup>=0&&selected&&snapshot.mode==="live") {
      const day=previousYearDay(catalog,selected);
      if(day) {
        showWorking();
        const controller=new AbortController();
        historicalRead.current=controller;
        try {
          const {readComparisonDays}=await import("../counterComparisonData");
          const [summary]=await bounded(readComparisonDays(
            [day],controller.signal,previousYearWindow(plan.plans[lookup].period,day.date),
          ));
          response[lookup]=previousYearAnswer(plan.plans[lookup],summary);
        } catch {
          controller.abort();
          response[lookup]=previousYearAnswer(plan.plans[lookup],undefined);
        }
        if(requestId!==generation.current) return;
        historicalRead.current=null;
      }
    }
    inFlight.current=false;
    setWorking(false);
    if(isOpen.current&&motionTimer.current===undefined) setMotion("living");
    if(plan.reset) cancelRequest();
    const routine=plan.plans.find(item=>item.intent==="routine");
    if(routine&&!routine.readOnly) setOffered(routine);
    previous.current=rememberRequest(plan,previous.current,Date.now());
    setNotes(current=>[...current.slice(-11),{prompt:text,response:response.length?response:[{text:plan.message??"対象を指定してください。"}]}]);
    setInput("");
    const item=response.find(result=>result.target);
    if(isOpen.current&&item?.target) focus(item.target,item.plan);
    if(isOpen.current&&response.some(item=>item.target==="graph")&&latestEvidence.current.prediction.length>0) changeMotion("forecast","living",1800);
  }
  const last=notes.at(-1);
  const detailed=last?.response.some(row=>row.target==="compare"||row.target==="graph"||row.text.length>150);
  const stage=detailed?3:(notes.length>1||monitor||offered)?2:1;
  return <aside className="lux-dock" data-open={open} data-mounted={mounted} data-stage={stage} data-motion={motion} data-has-answer={notes.length>0||working} aria-label="Luxnora">
    {mounted&&<div className="lux-screen-aura" aria-hidden="true" data-closing={!open}><div className="lux-aura-blue"/><div className="lux-aura-violet"/></div>}
    {mounted&&<section id="lux-panel" className="lux-panel" data-closing={!open} inert={!open} aria-label="Luxnoraとの会話" onKeyDown={e=>{
      if(e.key==="Escape"){e.stopPropagation();changeOpen(false);}
    }}>
      <header><span className="lux-panel-brand"><picture className="lux-header-mark"><source media="(prefers-reduced-motion: reduce)" srcSet={motionAsset+"#idle"}/><img key={motion} alt="" width="42" height="36" src={motionAsset+"#"+motion}/></picture><strong>Luxnora</strong></span><button className="lux-close" onClick={()=>changeOpen(false)} aria-label="会話を閉じる"><span aria-hidden="true">×</span></button></header>
      <div ref={replies} className="lux-answers" role="log" aria-label="会話">
        {working&&<div className="lux-progress"><p role="status">依頼を確認しています…</p><button type="button" onClick={()=>{
          cancelRequest();
          setInput("");
        }}>取り消す</button></div>}
        {notes.map((note,i)=><div className="lux-turn" key={i}><p className="lux-question">{note.prompt}</p>{note.response.map((item,index)=><p className="lux-response" key={index}>{item.text}{item.target&&!item.plan?.operation&&!item.plan?.schedule&&note.response.length>1&&<button type="button" className="cm-text-action" onClick={()=>focus(item.target!,item.plan)}>該当箇所を表示</button>}</p>)}</div>)}
      </div>

      <details className="lux-support"><summary>支援設定</summary><label className="lux-setting">支援 <select value={setting} onChange={e=>{setSetting(e.target.value);try {localStorage.setItem("pcs-counter-lux-support",e.target.value);}catch{}}}><option value="onRequest">指示したときのみ</option><option value="smart">スマートサポート</option><option value="active">積極的なサポート</option></select></label><label className="lux-setting">処理モード <select value={profile} onChange={e=>{
        const next=e.target.value==="swift"?"swift":"auto";
        setProfile(next);
        try {localStorage.setItem("counter-lux-profile",next);}catch{}
      }}><option value="auto">Luxnora Auto</option><option value="swift">Luxnora Swift</option></select></label></details>
      {setting!=="onRequest"&&evidence.config?.opened!=null&&!evidence.current&&<small>端末の通信状態または未同期記録を確認してください。</small>}
      {setting==="active"&&!!evidence.analysis?.issues.length&&<small>整合性の指摘 {evidence.analysis.issues.length}件を通過記録と照合できます。</small>}
      {offered&&<button onClick={()=>{monitorSnapshot.current="";setActivity([]);setMonitor({role:offered.role,until:Date.now()+15*60000});setOffered(null);}}>15分間の見守りを開始</button>}
      {monitor&&<button onClick={()=>{setMonitor(null);setActivity(rows=>[...rows.slice(-5),"見守りを終了しました。"]);}}>見守りを終了</button>}
      {!!activity.length&&<div className="lux-activity" aria-live="polite">{activity.map((text,i)=><p key={i}>{text}</p>)}</div>}
      <form className="lux-composer" onSubmit={event=>void submit(event)}>
        <input ref={prompt} aria-label="Luxnoraへの依頼" placeholder="何をしましょうか？" value={input} onChange={e=>setInput(e.target.value)} maxLength={320} autoComplete="off" disabled={working}/>
        <button type="submit" className="lux-send" aria-label={working?"解析中":"送信"} disabled={working||!input.trim()}>
          {working?<span className="lux-send-progress" aria-hidden="true"/>:<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>}
        </button>
      </form>
    </section>}
    <button ref={trigger} className="lux-trigger" aria-label="Luxnora" aria-expanded={open} aria-controls="lux-panel" onClick={()=>changeOpen(!open)}>
      <picture>
        <source media="(prefers-reduced-motion: reduce)" srcSet={motionAsset+"#idle"}/>
        <img className="lux-mark" alt="" width="43" height="37" src={motionAsset+"#"+(open?"idle":motion)}/>
      </picture>
    </button>
  </aside>;
}
