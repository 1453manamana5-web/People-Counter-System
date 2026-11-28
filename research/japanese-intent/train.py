"""Offline intent/abstention prototypes. No user conversations enter the corpus."""
import json
from pathlib import Path
import unicodedata

import numpy as np

ROOT = Path(__file__).resolve().parent
CORPUS = json.loads((ROOT/"corpus.json").read_text())
LABELS = list(CORPUS["train"])
ABSTAIN = LABELS.index("abstain")


def grams(text):
    text = "^"+unicodedata.normalize("NFKC", text)+"$"
    return {text[i:i+n] for n in (1,2,3) for i in range(len(text)-n+1)}


def matrix(split, vocab):
    rows = [(text,LABELS.index(label)) for label,texts in CORPUS[split].items() for text in texts]
    x = np.zeros((len(rows),len(vocab)), dtype=np.float32)
    for i, (text, _) in enumerate(rows):
        for unit in grams(text):
            if unit in vocab:
                x[i,vocab[unit]] = 1
    x /= np.maximum(np.linalg.norm(x,axis=1,keepdims=True),1)
    return x, np.array([row[1] for row in rows])


def softmax(values):
    values = np.exp(values-values.max(axis=1,keepdims=True))
    return values/values.sum(axis=1,keepdims=True)


def train(hidden, x, labels):
    rng = np.random.default_rng(411)
    target = np.eye(len(LABELS),dtype=np.float32)[labels]
    first = rng.normal(0,.09,(x.shape[1],hidden or len(LABELS))).astype(np.float32)
    last = rng.normal(0,.16,(hidden,len(LABELS))).astype(np.float32) if hidden else None
    for _ in range(360):
        projected=x@first
        intermediate=np.tanh(projected) if hidden else projected
        probabilities=softmax(intermediate@last if hidden else intermediate)
        err=(probabilities-target)/len(x)
        hidden_err=(err@last.T)*(1-intermediate*intermediate) if hidden else err
        if hidden:
            last-=.55*(intermediate.T@err+.001*last)
        first-=.55*(x.T@hidden_err+.001*first)
    return first,last


def metrics(probs, labels, threshold):
    predictions=probs.argmax(1)
    predictions[probs.max(1)<threshold]=ABSTAIN
    confident=predictions!=ABSTAIN
    return {"cases":len(labels),"matched":int((predictions==labels).sum()),
            "read_proposals":int(confident.sum()),"false_read":int((confident&(labels==ABSTAIN)).sum()),
            "wrong_intent":int((confident&(labels!=ABSTAIN)&(predictions!=labels)).sum()),
            "polite_refusal":int(((~confident)&(labels!=ABSTAIN)).sum()),
            "predictions":[LABELS[i] for i in predictions]}


def main():
    vocabulary=sorted(set().union(*(grams(text) for items in CORPUS["train"].values() for text in items)))
    vocab={unit:i for i,unit in enumerate(vocabulary)}
    x, labels=matrix("train",vocab)
    valid, vy=matrix("validation",vocab)
    test, ty=matrix("independent",vocab)
    weights={}
    report={"train_cases":len(labels),"validation_cases":len(vy),"vocabulary":len(vocab),"models":{}}
    for name, hidden in (("linear",0),("mlp",24)):
        first,last=train(hidden,x,labels)
        def predict(features):
            projected=features@first
            return softmax(np.tanh(projected)@last if last is not None else projected)
        validated=predict(valid)
        def risk(t):
            m=metrics(validated,vy,t)
            return (5*m["false_read"]+2*m["wrong_intent"]+m["polite_refusal"],-m["matched"])
        threshold=min((.2,.3,.4,.5,.6,.7,.8),key=risk)
        weights[name+"_first"]=first
        if last is not None:
            weights[name+"_last"]=last
        report["models"][name]={"threshold":threshold,"validation":metrics(validated,vy,threshold),
                                "independent":metrics(predict(test),ty,threshold)}
    np.savez_compressed(ROOT/"weights.npz",**weights,vocabulary=np.asarray(vocabulary),labels=np.asarray(LABELS))
    (ROOT/"metrics.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")


if __name__=="__main__":
    main()
