"""Score the unchanged v5 research selector on the shared prompts."""
import json
from pathlib import Path
import unicodedata

import numpy as np

ROOT=Path(__file__).resolve().parent
prior=np.load(ROOT.parent/"application-language/selector.npz")
vocab={unit:i for i,unit in enumerate(prior["vocabulary"])}
groups=json.loads((ROOT/"structured.json").read_text())["independent"]
common={row["text"] for row in json.loads((ROOT/"generation-cases.json").read_text())}


def predict(text):
    text="^"+unicodedata.normalize("NFKC",text)+"$"
    x=np.zeros(len(vocab),np.float32)
    for size in (1,2,3):
        for index in range(len(text)-size+1):
            unit=text[index:index+size]
            if unit in vocab:
                x[vocab[unit]]=1
    scores=(x/max(1,np.linalg.norm(x)))@prior["weights"]
    relative=np.exp(scores-scores.max())
    probabilities=relative/relative.sum()
    top=int(probabilities.argmax())
    return str(prior["labels"][top]) if probabilities[top]>=prior["cutoff"] else "abstain"


def metrics(items):
    rows=[{"text":row["text"],"expected":row["capability"],"actual":predict(row["text"])} for row in items]
    return {"cases":len(rows),"correct":sum(row["actual"]==row["expected"] for row in rows),
            "falseRead":sum(row["actual"]!="abstain" and row["expected"]=="abstain" for row in rows),"rows":rows}


print(json.dumps({"all":metrics(groups),"common":metrics([row for row in groups if row["text"] in common])},
                 ensure_ascii=False,indent=2))
