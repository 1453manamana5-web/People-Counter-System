export function ngrams(text) {
  const chars=Array.from("^"+text.normalize("NFKC").toLowerCase().trim()+"$");
  const codes=new Set();
  for(let start=0;start<chars.length;start++) {
    let code=0;
    for(let i=start;i<Math.min(start+3,chars.length);i++) {
      code=(code*31+chars[i].codePointAt(0))%256;
      codes.add(code);
    }
  }
  return Array.from({length:256},(_,i)=>codes.has(i)?1/Math.sqrt(codes.size):0);
}

function dense(input,matrix,bias) {
  return matrix.map((row,i)=>row.reduce((sum,w,j)=>sum+w*input[j],bias[i]));
}

export function classify(model,{text,topics,active},embedding) {
  const input=model.mode==="ruri"?embedding:ngrams(text);
  const state=[...model.topics.map(t=>Number(topics.includes(t))),...model.topics.map(t=>Number(t===active))];
  const weights=model.weights;
  if(!input || input.length+state.length!==weights["0.weight"][0].length) throw Error("Invalid input dimensions");
  const features=dense([...input,...state],weights["0.weight"],weights["0.bias"]).map(v=>Math.max(0,v));
  const logits=dense(features,weights["2.weight"],weights["2.bias"]);
  return model.topics[logits.indexOf(Math.max(...logits))];
}
