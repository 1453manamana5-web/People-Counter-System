// Research-only evaluator. A null result leaves the existing assistant in control.
export function createBrowserReference() {
  let worker;
  let pendingCancel;
  let idle;
  let nextId=0;
  const clear=()=>{
    clearTimeout(idle);
    worker?.terminate();
    worker=undefined;
  };
  return {release() {pendingCancel?.();clear();}, predict(mode,rows,signal) {
    if(signal?.aborted||pendingCancel||typeof Worker==="undefined") return Promise.resolve(null);
    try {worker??=new Worker(new URL("./model.worker.mjs",import.meta.url),{type:"module"});}
    catch {return Promise.resolve(null);}
    const active=worker;
    clearTimeout(idle);
    const id=++nextId;
    return new Promise(resolve=>{
      const finish=(value,terminate)=>{
        clearTimeout(timer);
        active.removeEventListener("message",receive);
        active.removeEventListener("error",cancel);
        signal?.removeEventListener("abort",cancel);
        pendingCancel=undefined;
        if(terminate) clear();
        else idle=setTimeout(clear,60000);
        resolve(value);
      };
      const cancel=()=>finish(null,true);
      const receive=({data})=>{if(data.id===id) finish(data.values,data.values===null);};
      const timer=setTimeout(cancel,30000);
      pendingCancel=cancel;
      active.addEventListener("message",receive);
      active.addEventListener("error",cancel);
      signal?.addEventListener("abort",cancel,{once:true});
      try {active.postMessage({id,mode,rows});}
      catch {cancel();}
    });
  }};
}
