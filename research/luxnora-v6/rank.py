"""Compare a learned read-only evidence ranker against hard validation and cost order."""
import argparse
import json
from pathlib import Path
from time import perf_counter

import torch
from torch import nn

torch.set_num_threads(1)
SOURCES=("recent-report","cached-report","missing")
FEATURES=("recent","cached","no-source","valid-count","same-scope","server","near-deadline")


def create(split):
    # Split by failure combination. Independent rows use age and count values
    # that the training split never sees, and include simultaneous faults.
    ages={"train":(1,90,220),"validation":(15,175,190),"independent":(2,180,181,360)}[split]
    counts={"train":(0,2,9,None),"validation":(1,13,None),"independent":(3,11,15,-1,None)}[split]
    rows=[]
    for age in ages:
        for count in counts:
            for same in (True,False):
                for server in (True,False):
                    for tight in (True,False):
                        if split=="train" and ((not same)+(not server)+int(count is None)>2):
                            continue
                        valid=count is not None and count>=0
                        recent=server and age<=180
                        permits=[same and valid and recent,same and valid and not recent,True]
                        features=[[int(i==0),int(i==1),int(i==2),int(valid),int(same),int(server),int(tight)]
                                  for i in range(3)]
                        target=permits.index(True)
                        rows.append({"age_seconds":age,"count":count,"same_scope":same,"server":server,
                            "tight":tight,"features":features,"eligible":permits,"target":target,
                            "fallback_steps":[SOURCES[target]],"blocked_alternatives":[SOURCES[i] for i in range(3) if not permits[i]]})
    return rows


def arrays(rows):
    return (torch.tensor([row["features"] for row in rows],dtype=torch.float32),
            torch.tensor([row["eligible"] for row in rows]),
            torch.tensor([row["target"] for row in rows]))


def score(logits, eligible, target):
    raw=logits.argmax(1)
    checked=logits.masked_fill(~eligible,-torch.inf).argmax(1)
    return {"cases":len(target),"raw_correct":int((raw==target).sum()),
            "raw_ineligible":int((~eligible.gather(1,raw[:,None])).sum()),
            "with_guard_correct":int((checked==target).sum()),
            "with_guard_ineligible":int((~eligible.gather(1,checked[:,None])).sum()),
            "deterministic_correct":int((eligible.int().argmax(1)==target).sum())}


def run(out):
    splits={name:create(name) for name in ("train","validation","independent")}
    x,_,y=arrays(splits["train"])
    results=[]
    for seed in (60,61,62):
        torch.manual_seed(seed)
        model=nn.Sequential(nn.Linear(len(FEATURES),12),nn.SiLU(),nn.Linear(12,1))
        optimizer=torch.optim.AdamW(model.parameters(),lr=.015)
        begin=perf_counter()
        curve=[]
        for epoch in range(160):
            logits=model(x).squeeze(-1)
            loss=nn.functional.cross_entropy(logits,y)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            if epoch%20==0:
                curve.append(float(loss.detach()))
        with torch.inference_mode():
            result={}
            for split in ("validation","independent"):
                features,eligible,target=arrays(splits[split])
                result[split]=score(model(features).squeeze(-1),eligible,target)
        results.append({"seed":seed,"seconds":perf_counter()-begin,"curve":curve,**result})
        torch.save(model.state_dict(),out/f"rank-{seed}.pt")
    (out/"ranking.json").write_text(json.dumps({"features":FEATURES,"sources":SOURCES,"results":results},indent=2)+"\n")
    (out/"ranking-data.json").write_text(json.dumps(splits,separators=(",",":"))+"\n")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out",type=Path)
    opts=parser.parse_args()
    run(opts.out)
