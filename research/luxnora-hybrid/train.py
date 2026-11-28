"""Seeded CPU comparison for local capability candidate retrieval."""
import json
from pathlib import Path
from time import perf_counter
import unicodedata

import numpy as np

ROOT=Path(__file__).resolve().parent
CAP=ROOT.parents[1]/"management-app/src/luxnora"
BINS=768
groups=json.loads((ROOT/"phrases.json").read_text())
old=json.loads((ROOT.parent/"application-language/corpus.json").read_text())["train"]
labels=list(groups["train"])
reject=labels.index("abstain")
for label, sentences in old.items():
    groups["train"][label].extend(sentences)


def normalized(text):
    return unicodedata.normalize("NFKC",text).lower().strip()


def vector(text):
    text="^"+normalized(text)+"$"
    features=set(text[i:i+n] for n in (1,2,3) for i in range(len(text)-n+1))
    result=np.zeros(BINS,np.float32)
    for term in features:
        code=0
        for char in term:
            code=(31*code+ord(char))%BINS
        result[code]=1
    return result/max(1.,np.linalg.norm(result))

# Labels include the intended outcome rather than generated executable commands.
all_rows={}
seen={}
registry=(CAP/"capabilities.ts").read_text()
for split, items in groups.items():
    rows=[]
    for label, texts in items.items():
        if label!="abstain" and f'id:"{label}"' not in registry:
            raise ValueError(label)
        for text in texts:
            key=normalized(text)
            if key in seen:
                raise ValueError((text,seen[key],split))
            seen[key]=split
            rows.append({"text":text,"goal":"clarify" if label=="abstain" else "guidance",
                         "capability":label,"effect":"read-only","source_group":split})
    all_rows[split]=rows


def arrays(rows):
    return np.stack([vector(row["text"]) for row in rows]),np.array([labels.index(row["capability"]) for row in rows])


def softmax(x):
    out=np.exp(x-x.max(axis=1,keepdims=True))
    return out/out.sum(axis=1,keepdims=True)


def train(hidden, auxiliary):
    start=perf_counter()
    x,y=arrays(all_rows["train"])
    rng=np.random.default_rng(8151)
    first=(np.zeros((BINS,len(labels)),dtype=np.float32) if not hidden else
           rng.normal(0,.10,(BINS,hidden)).astype(np.float32))
    last=rng.normal(0,.16,(hidden,len(labels))).astype(np.float32) if hidden else None
    aux=np.zeros(hidden,np.float32) if auxiliary else None
    target=np.eye(len(labels),dtype=np.float32)[y]
    safe=(y!=reject).astype(np.float32)
    for _ in range(450):
        hidden_state=np.tanh(x@first) if hidden else x@first
        err=(softmax(hidden_state@last if hidden else hidden_state)-target)/len(x)
        grad=err@last.T if hidden else err
        if aux is not None:
            out=1/(1+np.exp(-hidden_state@aux))
            additional=(out-safe)*(.45/len(x))
            grad+=additional[:,None]*aux
            aux-=.6*(hidden_state.T@additional+.001*aux)
        if hidden:
            last-=.6*(hidden_state.T@err+.001*last)
            grad*=1-hidden_state**2
        first-=.6*(x.T@grad+.001*first)
    return first,last,aux,perf_counter()-start


def quantized(weights):
    size=float(np.max(np.abs(weights)))/127
    return np.rint(weights/size).astype(np.int8),size


def compare(name, hidden=0, auxiliary=False):
    first,last,aux,seconds=train(hidden,auxiliary)
    quant,scale=quantized(first)
    first=quant.astype(np.float32)*scale
    def prediction(rows, cut, margin):
        x,y=arrays(rows)
        scores=softmax(np.tanh(x@first)@last if hidden else x@first)
        if aux is not None:
            guide=1/(1+np.exp(-np.tanh(x@first)@aux))
        else:
            guide=np.ones(len(x))
        rank=np.argsort(-scores,axis=1,kind="stable")
        decisions=rank[:,0].copy()
        gap=scores[np.arange(len(x)),rank[:,0]]-scores[np.arange(len(x)),rank[:,1]]
        decisions[(scores.max(axis=1)<cut)|(gap<margin)|(guide<.50)]=reject
        false=(y==reject)&(decisions!=reject)
        wrong=(y!=reject)&(decisions!=reject)&(decisions!=y)
        return {"cases":len(x),"correct":int((decisions==y).sum()),"false_read":int(false.sum()),
                "wrong_guide":int(wrong.sum()),
                "predictions":[labels[i] for i in decisions]}
    def risk(pair):
        m=prediction(all_rows["validation"],*pair)
        return (m["cases"]-m["correct"]+8*m["false_read"]+3*m["wrong_guide"],-pair[1])
    cutoff,margin=min(((cut,gap) for cut in (.2,.3,.4,.5,.6) for gap in (.05,.10,.18)),key=risk)
    result={"seconds":seconds,"cutoff":cutoff,"margin":margin,
            **{split:prediction(all_rows[split],cutoff,margin) for split in ("validation","independent")}}
    weights={"first":quant,"scale":scale,"labels":np.array(labels),"cutoff":cutoff,"margin":margin}
    if hidden: weights["last"]=last
    if aux is not None: weights["aux"]=aux
    np.savez_compressed(ROOT/(name+".npz"),**weights)
    if name=="linear":
        model={"bins":BINS,"labels":labels,"weights":quant.T.tolist(),"scale":scale,"cutoff":cutoff,"margin":margin}
        (ROOT/"linear-browser.json").write_text(json.dumps(model,separators=(",",":"))+"\n")
    return result


report={"counts":{split:len(rows) for split,rows in all_rows.items()},
        "models":{name:compare(name,h,a) for name,h,a in (("linear",0,False),("mlp",32,False),("multitask",32,True))}}
(ROOT/"structured.json").write_text(json.dumps(all_rows,ensure_ascii=False,indent=2)+"\n")
(ROOT/"metrics.json").write_text(json.dumps(report,indent=2)+"\n")
print({name:(m["independent"]["correct"],m["independent"]["false_read"],m["independent"]["wrong_guide"]) for name,m in report["models"].items()})
