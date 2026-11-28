"""Train reference selectors on raw dialogues and actual Core-derived states."""
import argparse
import json
from pathlib import Path
from time import perf_counter
import unicodedata

import numpy as np
import torch
from torch import nn

TOPICS = ("comparison", "station", "count", "records", "diagnosis", "clarify")
BINS = 256
torch.set_num_threads(1)


def ngrams(raw):
    text = "^" + unicodedata.normalize("NFKC", raw).lower().strip() + "$"
    result = np.zeros(BINS, np.float32)
    for start in range(len(text)):
        code = 0
        for char in text[start:start+3]:
            code = (code*31+ord(char))%BINS
            result[code] = 1
    return result / max(1, np.linalg.norm(result))


def state_vector(item, mode):
    state = item["inferred"]
    if mode == "oracle":
        return [float(x in item["gold"]) for x in TOPICS] + [float(item["goldActive"] == x)
                                                            for x in TOPICS]
    if mode == "summary":
        return [float(x in state["trace"]) for x in TOPICS] + [float(state["trace"][-1] == x) for x in TOPICS]
    return [float(x in state["topics"]) for x in TOPICS] + [float(state["active"] == x) for x in TOPICS]


def vector(item, mode, ruri):
    last = ngrams(item["text"])
    if mode == "current":
        return last
    if mode == "recent":
        return np.concatenate([ngrams(s) for s in item["turns"][-3:]])
    if mode == "sequence":
        prefix = [np.zeros(BINS,np.float32)]*max(0, 12-len(item["turns"]))
        return np.stack([*prefix,*[ngrams(s) for s in item["turns"][-12:]]])
    text = ruri[item["text"]] if mode == "ruri" else last
    return np.concatenate([text, np.asarray(state_vector(item,mode),np.float32)])


class Sequence(nn.Module):
    def __init__(self):
        super().__init__()
        self.recurrent = nn.GRU(BINS,32,batch_first=True)
        self.head = nn.Linear(32,len(TOPICS))

    def forward(self,x):
        return self.head(self.recurrent(x)[0][:,-1])


def run(mode, rows, ruri, seed, steps):
    x = {key:torch.from_numpy(np.stack([vector(row,mode,ruri) for row in values])) for key,values in rows.items()}
    y = {key:torch.tensor([TOPICS.index(row["expected"]) for row in values]) for key,values in rows.items()}
    torch.manual_seed(seed)
    model = Sequence() if mode == "sequence" else nn.Sequential(nn.Linear(x["train"].shape[1],48),nn.ReLU(),nn.Linear(48,len(TOPICS)))
    optimizer = torch.optim.AdamW(model.parameters(),lr=.007)
    order = torch.Generator().manual_seed(seed)
    curve = []
    start = perf_counter()
    for _ in range(steps):
        for idx in torch.randperm(len(y["train"]),generator=order).split(64):
            loss = nn.functional.cross_entropy(model(x["train"][idx]),y["train"][idx])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        with torch.inference_mode():
            curve.append(int((model(x["validation"]).argmax(1)==y["validation"]).sum()))
    with torch.inference_mode():
        scores = {}
        predictions = {}
        for split in ("validation","independent"):
            pred = model(x[split]).argmax(1)
            good = (pred == y[split]).tolist()
            groups = {}
            for row,match in zip(rows[split],good,strict=True):
                group = groups.setdefault(row["structure"],{"correct":0,"cases":0})
                group["correct"] += int(match)
                group["cases"] += 1
            scores[split] = {"correct":sum(good),"cases":len(good),"structure":groups}
            predictions[split] = [TOPICS[index] for index in pred.tolist()]
    return model,{"seed":seed,"seconds":perf_counter()-start,"curve":curve,**scores},predictions


def portable(model, mode):
    return {"mode":mode,"topics":TOPICS,"weights":{key:value.tolist() for key,value in model.state_dict().items()}}


def main(data, out):
    out.mkdir(parents=True,exist_ok=True)
    rows = {name:[json.loads(row) for row in (data/(name+".jsonl")).read_text().splitlines()]
            for name in ("train","validation","independent")}
    embedded = json.loads((data/"ruri.json").read_text())
    ruri = {key:np.array(value,np.float32) for key,value in zip(embedded["texts"],embedded["vectors"],strict=True)}
    modes = ("current","recent","summary","state","ruri","sequence","oracle")
    results, references, predictions = {}, {}, {}
    for mode in modes:
        results[mode] = []
        for seed in (531,532,533):
            model, report, pred = run(mode,rows,ruri,seed,24)
            results[mode].append(report)
            if seed == 531:
                torch.save({"mode":mode,"weights":model.state_dict()},out/(mode+".pt"))
                predictions[mode] = pred["independent"]
                if mode in ("state","ruri"):
                    (out/(mode+".json")).write_text(json.dumps(portable(model,mode),separators=(",",":"))+"\n")
                    references[mode] = [{"text":row["text"],"topics":row["inferred"]["topics"],"active":row["inferred"]["active"],
                        "prediction":label} for row,label in zip(rows["independent"],pred["independent"],strict=True)]
        print(mode,[(r["validation"]["correct"],r["independent"]["correct"]) for r in results[mode]],flush=True)
    (out/"metrics.json").write_text(json.dumps(results,indent=2)+"\n")
    (out/"predictions.json").write_text(json.dumps(predictions)+"\n")
    (out/"browser-reference.json").write_text(json.dumps(references,ensure_ascii=False)+"\n")


if __name__ == "__main__":
    cli=argparse.ArgumentParser()
    cli.add_argument("data",type=Path)
    cli.add_argument("out",type=Path)
    args=cli.parse_args()
    main(args.data,args.out)
