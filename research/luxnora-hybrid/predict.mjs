export function predict(model, raw) {
  const text=Array.from("^"+raw.normalize("NFKC").toLowerCase().trim()+"$");
  const bins=new Set();
  for(let size=1;size<=3;size++) {
    for(let start=0;start+size<=text.length;start++){
      let code=0;
      for(let i=start;i<start+size;i++) code=(31*code+text[i].codePointAt(0))%model.bins;
      bins.add(code);
    }
  }
  const scores=model.weights.map(row=>model.scale*[...bins].reduce((sum,index)=>sum+row[index],0)/
    Math.sqrt(Math.max(1,bins.size)));
  const max=Math.max(...scores);
  const exp=scores.map(score=>Math.exp(score-max));
  const total=exp.reduce((a,b)=>a+b,0);
  const top=exp.map((val,index)=>({confidence:val/total,id:model.labels[index]}))
    .sort((a,b)=>b.confidence-a.confidence);
  return top[0].confidence>=model.cutoff&&top[0].confidence-top[1].confidence>=model.margin?
    top[0].id:"abstain";
}
