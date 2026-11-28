import type {Intent} from "./language";

let worker:Worker|undefined;
let sequence=0;
let idleTimer:ReturnType<typeof setTimeout>|undefined;
let unavailableUntil=0;

export async function semanticRead(raw:string,signal?:AbortSignal):Promise<Intent|null> {
  if(signal?.aborted) return null;
  const text=raw.trim().replace(/[。？！?!]+$/,"");
  // Only short, read-only, otherwise unresolved queries go to the local model.
  if(text.length<5||text.length>80||/[0-9０-９]|[；;。\n]|変更|設定|操作|削除|修正|やめ|変え|停止|開場|閉場|再起動|権限|午前|午後|明日|昨日/.test(text)) return null;
  if (typeof Worker==="undefined"||typeof WebAssembly==="undefined"||Date.now()<unavailableUntil) return null;
  const base=new URL(import.meta.env.BASE_URL+"luxnora-assets/",location.origin).href;
  if(!worker) {
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    const timeout=setTimeout(cancel,4000);
    signal?.addEventListener("abort",cancel,{once:true});
    try {
      let check:Response|undefined;
      const cache=typeof caches==="undefined"?undefined:await caches.open("pcs-luxnora-model-index-v1").catch(()=>undefined);
      try {
        check=await fetch(base+"ready.json",{signal:controller.signal});
        if(check.ok) await cache?.put(base+"ready.json",check.clone()).catch(()=>{});
      }catch {check=await cache?.match(base+"ready.json");}
      if(!check?.ok||(await check.json()).model!=="ruri-v3-30m") throw Error("Model unavailable");
      if(signal?.aborted) return null;
      worker??=new Worker(new URL("./semantic.worker.ts",import.meta.url),{type:"module"});
    } catch {if(!signal?.aborted) unavailableUntil=Date.now()+60000;return null;}
    finally {clearTimeout(timeout);signal?.removeEventListener("abort",cancel);}
  }
  const active=worker;
  clearTimeout(idleTimer);
  const request=++sequence;
  return new Promise(resolve=>{
    const clear=()=>{
      clearTimeout(timer);
      signal?.removeEventListener("abort",cancel);
      active.removeEventListener("message",response);
      active.removeEventListener("error",broken);
    };
    const cancel=()=>{clear();active.terminate();if(worker===active)worker=undefined;resolve(null);};
    const broken=()=>{unavailableUntil=Date.now()+60000;cancel();};
    const response=(message:MessageEvent<{request:number;intent:Intent|null;unavailable?:boolean}>)=>{
      if(message.data.request!==request) return;
      if(message.data.unavailable){broken();return;}
      clear();
      if(worker===active&&request===sequence) idleTimer=setTimeout(()=>{
        if(worker!==active) return;
        active.terminate();
        worker=undefined;
      },120_000);
      resolve(message.data.intent);
    };
    const timer=setTimeout(broken,30000);
    active.addEventListener("message",response);
    active.addEventListener("error",broken);
    signal?.addEventListener("abort",cancel,{once:true});
    if(signal?.aborted) cancel();
    else active.postMessage({request,text,base});
  });
}
