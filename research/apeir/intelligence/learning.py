"""Observable-only diagnosis and paired horizon models."""
import argparse
import json
from pathlib import Path
from time import perf_counter

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from benchmark_world import PREDICTION_STEPS, WINDOW, sample
from world import N, ROOT_COUNT, WIDTH

torch.set_num_threads(1)
ROOTS=2*ROOT_COUNT
H=len(PREDICTION_STEPS)


def read(split, cache):
    file=cache/(split+".npz")
    if not file.exists():
        history,roots,state,gain,legal,tags,seed=[],[],[],[],[],[],[]
        for case,inputs,(target,future,effect,mask,_) in sample(split):
            history.append(inputs)
            roots.append(target)
            state.append(future)
            gain.append(effect)
            legal.append(mask)
            tags.append(case.group)
            seed.append(case.seed)
        np.savez_compressed(file,history=history,roots=roots,state=state,gain=gain,legal=legal,tags=tags,seed=seed)
    with np.load(file) as data:
        rows=tuple(torch.from_numpy(data[key]) for key in ("history","roots","state","gain","legal"))
        return rows,data["tags"],data["seed"]


class Net(nn.Module):
    def __init__(self,kind):
        super().__init__()
        self.kind=kind
        features=2*WIDTH
        self.encoder=nn.GRU(features,48,batch_first=True) if kind=="gru" else nn.Sequential(
            nn.Flatten(),nn.Linear(WINDOW*features,80),nn.SiLU(),nn.Linear(80,48),nn.SiLU())
        self.diagnosis=nn.Linear(48,ROOTS)
        self.state=nn.Linear(48,H*WIDTH)
        self.effect=nn.Linear(48,N*N*H)

    def forward(self,history):
        features=torch.cat((history.clamp(min=0),(history>=0).float()),dim=-1)
        rep=self.encoder(features)
        if self.kind=="gru":
            rep=rep[0][:,-1]
        return self.diagnosis(rep),self.state(rep).reshape(-1,H,WIDTH).sigmoid(),self.effect(rep).reshape(-1,N,N,H)


def loss(out,batch):
    root,state,effect=out
    _,truth,future,gain,mask=batch
    diagnostic=F.binary_cross_entropy_with_logits(root,truth.float(),pos_weight=torch.full((ROOTS,),1.6))
    forecast=F.smooth_l1_loss(state,future)
    weighted=1+gain.abs().clamp(max=2)
    delta=F.smooth_l1_loss(effect,gain,reduction="none")*weighted
    return 2*diagnostic + 3*forecast + delta[mask].mean()


@torch.inference_mode()
def infer(model,history):
    outputs=[]
    for block in history.split(512):
        out=model(block)
        outputs.append([out[0].sigmoid(),*out[1:]])
    return tuple(torch.cat(items).numpy() for items in zip(*outputs))


def diagnostic(prob, truth, threshold):
    predicted=prob>=threshold
    abnormal=truth.any(1)
    severe=(truth.sum(1)>1)|truth[:,[3,8]].any(1)
    exact=(predicted==truth).all(1)
    alert=predicted.any(1)
    return {"cases":len(truth),"exact":int(exact.sum()),"abnormal":int(abnormal.sum()),
      "abnormal_exact":int((abnormal&exact).sum()),"severe":int(severe.sum()),
      "severe_missed":int((severe&~alert).sum()),"missed":int((abnormal&~alert).sum()),
      "normal":int((~abnormal).sum()),"false_alarms":int((~abnormal&alert).sum()),
      "brier":float(np.square(prob-truth).mean())}


def threshold_for(prob,truth):
    def score(limit):
        stats=diagnostic(prob,truth,limit)
        return stats["exact"] - 3*stats["severe_missed"] - 1.5*stats["missed"] - .3*stats["false_alarms"]
    return max((.20,.30,.40,.50,.60,.70),key=score)


def score(model,data,threshold):
    d,base,gain=infer(model,data[0])
    _,truth,future,actual,legal=(tensor.numpy() for tensor in data)
    mask=legal.copy()
    mask[:,0,0]=False
    counts=int(mask.sum())
    return {**diagnostic(d,truth,threshold),
        "effect_pairs":counts,
        "effect_mae":abs(gain[mask]-actual[mask]).mean(0).tolist() if counts else None,
        "zero_effect_mae":abs(actual[mask]).mean(0).tolist() if counts else None,
        "state_mae":abs(base-future).mean((0,2)).tolist(),
        "persist_mae":abs(data[0].numpy()[:,-1,None,:].clip(0,1)-future).mean((0,2)).tolist()}


def fit(kind,seed,train,dev,epochs):
    torch.manual_seed(seed)
    model=Net(kind)
    opt=torch.optim.AdamW(model.parameters(),lr=.0025)
    rng=torch.Generator().manual_seed(seed)
    records=[]
    started=perf_counter()
    for _ in range(epochs):
        for ids in torch.randperm(len(train[0]),generator=rng).split(112):
            data=tuple(x[ids] for x in train)
            cost=loss(model(data[0]),data)
            opt.zero_grad()
            cost.backward()
            opt.step()
        with torch.inference_mode():
            records.append(float(loss(model(dev[0]),dev)))
    return model.eval(),{"seconds":perf_counter()-started,"validation_loss":records}


def load_model(path):
    checkpoint=torch.load(path,weights_only=True)
    model=Net(checkpoint["kind"])
    model.load_state_dict(checkpoint["weights"])
    return model.eval(),checkpoint["threshold"]


def train(cache,out):
    dataset,_,_=read("train",cache)
    dev,_,_=read("validation",cache)
    history={"train_count":len(dataset[0]),"validation_count":len(dev[0]),"candidates":{}}
    for kind in ("mlp","gru"):
        for seed in (121,122,123):
            name=f"{kind}-{seed}"
            model,record=fit(kind,seed,dataset,dev,24)
            probability,_,_=infer(model,dev[0])
            cutoff=threshold_for(probability,dev[1].numpy())
            record["threshold"]=cutoff
            checkpoint=out/(name+".pt")
            torch.save({"kind":kind,"weights":model.state_dict(),"threshold":cutoff},checkpoint)
            record["bytes"]=checkpoint.stat().st_size
            record["score"]=score(model,dev,cutoff)
            history["candidates"][name]=record
            print(name,record["score"]["exact"],record["score"]["severe_missed"],flush=True)
    def rank(entry):
        stats=entry[1]["score"]
        return (stats["exact"]-3*stats["severe_missed"]-1.5*stats["missed"],-stats["effect_mae"][2])
    history["chosen"]=max(history["candidates"].items(),key=rank)[0]
    (out/"training.json").write_text(json.dumps(history,indent=2)+"\n")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache",required=True,type=Path)
    parser.add_argument("--out",type=Path,default=Path(__file__).with_name("artifacts"))
    args=parser.parse_args()
    args.cache.mkdir(parents=True,exist_ok=True)
    args.out.mkdir(parents=True,exist_ok=True)
    train(args.cache,args.out)
