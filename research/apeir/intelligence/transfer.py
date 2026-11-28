"""Probe few-shot adaptation and knowledge retrieval without changing representatives."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
from time import perf_counter

import numpy as np
import torch

import benchmark_world as bench
from core import Intelligence
from knowledge import Knowledge
from learning import Net, diagnostic, infer, load_model, loss, read, score

HERE=Path(__file__).resolve().parent


def experiment(cache,out):
    selected=json.loads((out/"training.json").read_text())["chosen"]
    parent,threshold=load_model(out/(selected+".pt"))
    engine=Intelligence(parent,[],knowledge=Knowledge(out/"knowledge.json"))
    tasks=json.loads((HERE/"knowledge-cases.json").read_text())
    knowledge=[]
    for goal,value,key,expected in tasks:
        result=engine.explain(goal,value)
        actual=result[key] if result is not None and key is not None else result
        correct=expected in actual if isinstance(actual,list) else actual==expected
        knowledge.append({"goal":goal,"value":value,"result":result,"correct":correct})

    # A separate shifted seed band; fixed and fresh are measurement only.
    training,tags,_=read("adaptation",cache)
    old,_,_=read("fixed",cache)
    shifted,_,_=read("fresh",cache)
    previous,_,_=read("train",cache)
    shifts={"baseline":{"fixed":score(parent,old,threshold),"fresh":score(parent,shifted,threshold)}}
    for seed in (151,152,153):
        rng=np.random.default_rng(seed)
        indices=np.concatenate([rng.choice(np.flatnonzero(tags==tag),8,replace=False) for tag in bench.GROUPS])
        replay=rng.choice(len(previous[0]),64,replace=False)
        for method in ("scratch","transfer","replay"):
            torch.manual_seed(seed)
            candidate=Net(parent.kind) if method=="scratch" else deepcopy(parent)
            opt=torch.optim.AdamW(candidate.parameters(),lr=.0015)
            begin=perf_counter()
            for _ in range(12):
                for ids,old_ids in zip(np.array_split(rng.permutation(indices),4),np.array_split(rng.permutation(replay),4)):
                    rows=tuple(torch.cat((x[ids],y[old_ids])) if method=="replay" else x[ids]
                               for x,y in zip(training,previous))
                    cost=loss(candidate(rows[0]),rows)
                    opt.zero_grad()
                    cost.backward()
                    opt.step()
            shifts.setdefault(method,[]).append({"seed":seed,"seconds":perf_counter()-begin,
                "fixed":score(candidate.eval(),old,threshold),"fresh":score(candidate,shifted,threshold)})
            if seed==151:
                torch.save({"kind":candidate.kind,"weights":candidate.state_dict(),"threshold":threshold},
                           out/(method+"-adaptation.pt"))
    ablation={}
    for name,split in (("fixed",old),("fresh",shifted)):
        history=split[0]
        prob,_,_=infer(parent,history)
        filtered=prob.copy()
        for side in range(2):
            for root,signal in ((0,0),(1,1),(3,3)):
                filtered[history[:,-1,side*10+signal].numpy()==1,side*5+root]=0.
        compressed=history[:,-1:,:].repeat(1,history.shape[1],1)
        no_history,_,_=infer(parent,compressed)
        ablation[name]={"full":diagnostic(prob,split[1].numpy(),threshold),
            "hypothesis_filter":diagnostic(filtered,split[1].numpy(),threshold),
            "latest_frame_only":diagnostic(no_history,split[1].numpy(),threshold)}
    report={"observation_ablation":ablation,"knowledge":{"passed":sum(row["correct"] for row in knowledge),"cases":knowledge},
            "adaptation":{"seed_band":1400000,"examples":64,"metrics":shifts}}
    (out/"supplement.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cache",required=True,type=Path)
    p.add_argument("--out",type=Path,default=HERE/"artifacts")
    a=p.parse_args()
    experiment(a.cache,a.out)
