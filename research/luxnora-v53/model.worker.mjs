import {classify} from "./inference.mjs";

const models=new Map();
let pipelinePromise;
const embeddings=new Map();
async function encoder() {
  const {env,pipeline}=await import("./luxnora-assets/transformers.min.js");
  env.allowRemoteModels=false;
  env.allowLocalModels=true;
  env.localModelPath=new URL("./luxnora-assets/",self.location.href).href;
  env.backends.onnx.wasm.numThreads=1;
  env.backends.onnx.wasm.wasmPaths=env.localModelPath+"wasm/";
  return pipeline("feature-extraction","ruri-v3-30m",{device:"wasm",dtype:"q8"});
}

async function embedding(text) {
  if(embeddings.has(text)) return embeddings.get(text);
  const extract=await (pipelinePromise??=encoder());
  const [vector]=(await extract(["トピック: "+text],{pooling:"mean",normalize:true})).tolist();
  if(embeddings.size===64) embeddings.delete(embeddings.keys().next().value);
  embeddings.set(text,vector);
  return vector;
}

self.onmessage=async ({data:{id,mode,rows}})=>{
  try {
    if(!["ruri","state"].includes(mode)||rows.length>400||rows.some(row=>row.text.length>180))
      throw Error("Unsupported reference request");
    if(!models.has(mode)) {
      const response=await fetch("./"+mode+".json");
      if(!response.ok) throw Error("Model unavailable");
      models.set(mode,await response.json());
    }
    const values=[];
    for(const row of rows) values.push(classify(models.get(mode),row,mode==="ruri"?await embedding(row.text):undefined));
    self.postMessage({id,values});
  } catch {self.postMessage({id,values:null});}
};
