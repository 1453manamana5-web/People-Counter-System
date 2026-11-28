"""Fit a character-feature capability selector for offline comparison only."""
import json
from pathlib import Path
import unicodedata

import numpy as np

ROOT=Path(__file__).resolve().parent
corpus=json.loads((ROOT/"corpus.json").read_text())
labels=list(corpus["train"])
holdout=json.loads((ROOT/"generation-cases.json").read_text())


def features(text):
    value="^"+unicodedata.normalize("NFKC",text)+"$"
    return {value[i:i+n] for n in (1,2,3) for i in range(len(value)-n+1)}


vocab=sorted(set().union(*(features(s) for rows in corpus["train"].values() for s in rows)))
lookup={token:i for i,token in enumerate(vocab)}


def matrix(rows):
    data=np.zeros((len(rows),len(vocab)),np.float32)
    for i,row in enumerate(rows):
        for token in features(row["text"]):
            if token in lookup:
                data[i,lookup[token]]=1
    data/=np.maximum(1,np.linalg.norm(data,axis=1,keepdims=True))
    return data,np.array([labels.index(row["id"]) for row in rows])


def split(name):
    return matrix([{"id":name,"text":text} for name,seq in corpus[name].items() for text in seq])


def softmax(logits):
    values=np.exp(logits-logits.max(axis=1,keepdims=True))
    return values/values.sum(axis=1,keepdims=True)


x,y=split("train")
validation,vy=split("validation")
test,ty=matrix(holdout)
weights=np.zeros((x.shape[1],len(labels)),np.float32)
target=np.eye(len(labels),dtype=np.float32)[y]
for _ in range(500):
    error=(softmax(x@weights)-target)/len(x)
    weights-=.7*(x.T@error+.001*weights)


def evaluate(inputs, expected, cutoff):
    probs=softmax(inputs@weights)
    result=probs.argmax(axis=1)
    last=labels.index("abstain")
    result[probs.max(axis=1)<cutoff]=last
    return {"cases":len(expected),"matched":int((result==expected).sum()),
            "false_read":int(((expected==last)&(result!=last)).sum()),
            "predictions":[labels[index] for index in result]}


def risk(cutoff):
    report=evaluate(validation,vy,cutoff)
    return (report["cases"]-report["matched"]+5*report["false_read"],cutoff)


cutoff=min((.25,.3,.4,.5,.6,.7),key=risk)
np.savez_compressed(ROOT/"selector.npz",weights=weights,vocabulary=np.array(vocab),labels=np.array(labels),cutoff=cutoff)
(ROOT/"selector-results.json").write_text(json.dumps({"training":len(y),"cutoff":cutoff,
    "validation":evaluate(validation,vy,cutoff),"independent":evaluate(test,ty,cutoff)},indent=2)+"\n")
