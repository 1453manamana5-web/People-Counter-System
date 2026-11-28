import {useEffect,useRef,useState,type FormEvent} from "react";
import {watchAlerts,type Answer,type Evidence,type Target} from "./assistant";
import {interpret,type Plan} from "./language";
import type {Profile} from "./runtime";
import {rememberTopics,type ContextMemory} from "./context";
import {readComparisonDays} from "../counterComparisonData";
import {processLuxnoraRequest} from "./core";
import {clearMemory,loadMemory,rememberExperience,saveProfile} from "./memory";
import type {SeriesAndDays} from "../counterEvents";
import {TaskQueue,type QueueState,type Task} from "./taskQueue";
import motionAsset from "./motion.svg?url";

export function LuxnoraPanel({evidence,catalog,focus,cancel,operator}:{operator:string;evidence:Evidence;catalog:SeriesAndDays|null;focus:(target:Target,plan?:Plan)=>void;cancel:()=>void}) {
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
  const scope=evidence.scope??"";
  const [memoryVisible,setMemoryVisible]=useState(false);
  const [profile,setProfile]=useState<Profile>(()=>{
    try {return loadMemory(localStorage,operator,scope,Date.now()).profile??"auto";}catch{return "auto";}
  });
  const [notes,setNotes]=useState<{prompt:string;response:Answer[]}[]>([]);
  const [setting,setSetting]=useState(()=>{
    try {return localStorage.getItem("pcs-counter-lux-support")??"smart";}catch{return "smart";}
  });
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
  const queue=useRef<TaskQueue<{text:string;profile:Profile}>|null>(null);
  const [queueState,setQueueState]=useState<QueueState>({active:false,waiting:0,paused:false});
  const working=queueState.active;
  useEffect(()=>{if(replies.current) replies.current.scrollTop=replies.current.scrollHeight;},[notes,mounted,queueState.active]);
  const [queueNotice,setQueueNotice]=useState("");
  const previous=useRef<ContextMemory>({topics:{}});
  const latest=useRef({evidence,catalog,focus});
  useEffect(()=>{latest.current={evidence,catalog,focus};},[evidence,catalog,focus]);
  const prompt=useRef<HTMLInputElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const runner=new TaskQueue(processTask,setQueueState,task=>{
      addReply(task.value.text,[{text:"確認を完了できませんでした。必要な場合はもう一度依頼してください。"}]);
    });
    queue.current=runner;
    return ()=>{runner.dispose();queue.current=null;};
  },[]);
  useEffect(()=>{
    if(!isOpen.current) return;
    clearTimeout(motionTimer.current);
    setMotion(queueState.active?"checking":"living");
  },[queueState.active]);
  function cancelRequest() {
    queue.current?.cancel();
    previous.current={topics:{}};
    cancel();
    setOffered(null);
    setMonitor(null);
    setQueueNotice("");
  }
  function addReply(text:string,response:Answer[]) {
    setNotes(current=>[...current.slice(-11),{prompt:text,response}]);
  }
  async function processTask(task:Task<{text:string;profile:Profile}>, signal:AbortSignal) {
    const {text,profile}=task.value;
    const allow=()=>Boolean(queue.current?.isLatest(task));
    const result=await processLuxnoraRequest({text,profile,context:previous.current,signal,
      allowConfirmation:allow,
      read:async(day,window,signal)=>(await readComparisonDays([day],signal,window))[0],
      observe:()=>{
        let experiences;
        try {experiences=loadMemory(localStorage,operator,scope,Date.now()).experiences;}catch{}
        return {...latest.current,experiences};
      },
      semantic:async(raw,signal)=>(await import("./semantic")).semanticRead(raw,signal),
    });
    if(!result||signal.aborted) return;
    const plan=result.request;
    const response=result.answers.map(row=>!allow()&&(row.plan?.operation||row.plan?.schedule)
      ? {text:"新しい依頼を受け付けたため、操作候補を取り下げました。"}:row);
    try {
      for (const kind of result.experiences) rememberExperience(localStorage,operator,scope,kind,Date.now());
    } catch {}
    const routine=plan.plans.find(item=>item.intent==="routine");
    if(routine&&!routine.readOnly&&allow()) setOffered(routine);
    previous.current=rememberTopics(plan,previous.current,Date.now());
    addReply(text,response.length?response:[{text:plan.message??"対象を指定してください。"}]);
    const target=response.find(row=>row.target);
    if(allow()&&isOpen.current&&target?.target) latest.current.focus(target.target,target.plan);
  }
  function submit(event:FormEvent) {
    event.preventDefault();
    const text=input.trim();
    if(!text) return;
    const cancellation=interpret(text);
    if(cancellation.reset) {
      cancelRequest();
      addReply(text,[{text:cancellation.message??"依頼を取り消しました。"}]);
      setInput("");
      return;
    }
    const status=queue.current?.enqueue(profile+":"+text.normalize("NFKC"),{text,profile});
    if(status==="full") {setQueueNotice("待機中の依頼が4件あります。完了するか、取り消してから送信してください。");return;}
    cancel();
    setOffered(null);
    setQueueNotice(status==="duplicate"?"同じ依頼を処理中です。":"");
    setInput("");
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
        {(working||queueState.paused||queueState.waiting>0)&&<div className="lux-progress">
          <p role="status">{queueState.paused?"中断中":working?"依頼を確認しています…":"待機中"}{queueState.waiting>0?"（待機 "+queueState.waiting+"件）":""}</p>
          <button type="button" onClick={()=>queueState.paused?queue.current?.resume():queue.current?.pause()}>{queueState.paused?"再開":"中断"}</button>
          <button type="button" onClick={cancelRequest}>取り消す</button>
        </div>}
        {queueNotice&&<p role="status">{queueNotice}</p>}
        {notes.map((note,i)=><div className="lux-turn" key={i}><p className="lux-question">{note.prompt}</p>{note.response.map((item,index)=><p className="lux-response" key={index}>{item.text}{item.target&&!item.plan?.operation&&!item.plan?.schedule&&note.response.length>1&&<button type="button" className="cm-text-action" onClick={()=>focus(item.target!,item.plan)}>該当箇所を表示</button>}</p>)}</div>)}
      </div>

      <details className="lux-support"><summary>支援設定</summary><label className="lux-setting">支援 <select value={setting} onChange={e=>{setSetting(e.target.value);try {localStorage.setItem("pcs-counter-lux-support",e.target.value);}catch{}}}><option value="onRequest">指示したときのみ</option><option value="smart">スマートサポート</option><option value="active">積極的なサポート</option></select></label><label className="lux-setting">処理モード <select value={profile} onChange={e=>{
        const next=e.target.value==="swift"?"swift":"auto";
        setProfile(next);
        try {saveProfile(localStorage,operator,scope,next,Date.now());}catch{}
      }}><option value="auto">Luxnora Auto</option><option value="swift">Luxnora Swift</option></select></label><button type="button" onClick={()=>setMemoryVisible(!memoryVisible)}>この開催区分の記憶</button>
        {memoryVisible&&<div>
          <p>処理モード {profile==="swift"?"Swift":"Auto"}</p>
          {(() => {
            try {return loadMemory(localStorage,operator,scope,Date.now()).experiences.map(item=>
              <p key={item.kind}>{item.kind==="ledger-recount"?"台帳の再集計":"前年記録の取得不可"} · {item.repeats}回</p>);}
            catch {return null;}
          })()}
          <button type="button" onClick={()=>{
            cancelRequest();
            try {clearMemory(localStorage,operator,scope);setProfile("auto");setNotes([]);}
            catch {setQueueNotice("記憶を削除できませんでした。");}
          }}>この開催区分の記憶を初期化</button>
        </div>}
      </details>
      {setting!=="onRequest"&&evidence.config?.opened!=null&&!evidence.current&&<small>端末の通信状態または未同期記録を確認してください。</small>}
      {setting==="active"&&!!evidence.analysis?.issues.length&&<small>整合性の指摘 {evidence.analysis.issues.length}件を通過記録と照合できます。</small>}
      {offered&&<button onClick={()=>{monitorSnapshot.current="";setActivity([]);setMonitor({role:offered.role,until:Date.now()+15*60000});setOffered(null);}}>15分間の見守りを開始</button>}
      {monitor&&<button onClick={()=>{setMonitor(null);setActivity(rows=>[...rows.slice(-5),"見守りを終了しました。"]);}}>見守りを終了</button>}
      {!!activity.length&&<div className="lux-activity" aria-live="polite">{activity.map((text,i)=><p key={i}>{text}</p>)}</div>}
      <form className="lux-composer" onSubmit={event=>void submit(event)}>
        <input ref={prompt} aria-label="Luxnoraへの依頼" placeholder="何をしましょうか？" value={input} onChange={e=>setInput(e.target.value)} maxLength={320} autoComplete="off"/>
        <button type="submit" className="lux-send" aria-label="送信" disabled={!input.trim()}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>
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
