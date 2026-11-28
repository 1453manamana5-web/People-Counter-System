"""Learn intervention response, action-conditioned transitions and planner priors."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
from time import perf_counter

import numpy as np
import torch
from torch import nn

from world import HORIZON, N, ROOT_COUNT, WIDTH, World, allowed, rules

torch.set_num_threads(1)
OUT=Path(__file__).with_name("artifacts")
HISTORY=3
TARGET=WIDTH+1


def contrast(world):
    """Paired do experiments; the simulation counterfactual is never a planner input."""
    original=deepcopy(world)
    original.step(0)
    base=original.observe(clean=True)
    features=[]
    for side in range(2):
        for root in range(ROOT_COUNT):
            changed=deepcopy(world)
            changed.intervention(side,root)
            changed.step(0)
            delta=changed.observe(clean=True)-base
            lost=original.state.lost[side]-changed.state.lost[side]
            features.append([*delta[side*10:side*10+5],lost])
    return np.asarray(features,np.float32).reshape(-1)


def target(w):
    return np.r_[w.observe(clean=True),float(w.bad())].astype(np.float32)


def action_scores(world, obs):
    """Privileged simulator demonstrations; used only during training and scoring."""
    scores=np.full(N,-100,np.float32)
    for action in np.flatnonzero(allowed(obs)):
        sim=deepcopy(world)
        loss=0.
        for step in range(3):
            info=sim.step(int(action) if step==0 else rules(sim.observe()))
            loss+=.16*sim.state.roots.sum()+.04*(sim.state.queues+sim.state.flight).sum()+.2*sim.state.lost.sum()
            if info["unnecessary"]:
                loss+=1.
            if sim.state.done:
                break
        scores[action]=-loss + (1.8 if sim.state.stable==2 else 0) - (.12 if action>=3 else 0)
        if action==2:
            scores[action] -= (0.4 if world.state.persistent.any() and world.state.now>=7 else 2.9)
        if action==1:
            scores[action] -= .03
    return scores


def collection(start, count, profile="standard", interventions=False, demonstrations=False):
    obs,actions,targets,roots,effects,teachers=[],[],[],[],[],[]
    rng=np.random.default_rng(start+10)
    for seed in range(start,start+count):
        w=World(seed,profile)
        frames=[w.observe()]*HISTORY
        while not w.state.done:
            history=np.stack(frames[-HISTORY:])
            mask=allowed(history[-1]); mask[2]=False
            a=rules(history[-1]) if rng.random()<.55 else int(rng.choice(np.flatnonzero(mask)))
            if demonstrations and rng.random()<.60:
                scores=action_scores(w,history[-1])
                teachers.append((history,scores))
            obs.append(history)
            actions.append(a)
            roots.append(w.state.roots.flatten().copy())
            if interventions and w.state.now%3==0:
                effects.append((contrast(w),roots[-1]))
            w.step(a)
            targets.append(target(w))
            frames.append(w.observe())
    return tuple(torch.as_tensor(np.asarray(v)) for v in (obs,actions,targets,roots)),effects,teachers


class Model(nn.Module):
    def __init__(self,kind,task):
        super().__init__()
        self.kind,self.task=kind,task
        self.engine=nn.GRU(WIDTH,32,batch_first=True) if kind=="gru" else nn.Sequential(
            nn.Flatten(),nn.Linear(WIDTH*HISTORY,64),nn.SiLU(),nn.Linear(64,32),nn.SiLU())
        use_action=task in ("world","effect")
        self.head=nn.Linear(32+(N if use_action else 0), {"world":TARGET,"cause":2*ROOT_COUNT,"prior":N,"value":N,"effect":TARGET}[task])

    def forward(self,x,a=None):
        z=self.engine(x)
        if self.kind=="gru":
            z=z[0][:,-1]
        if self.task in ("world","effect"):
            z=torch.cat((z,nn.functional.one_hot(a,N).float()),dim=-1)
        return self.head(z)


def load(name):
    value=torch.load(OUT/(name+".pt"),weights_only=True)
    model=Model(value["kind"],value["task"])
    model.load_state_dict(value["weights"])
    return model.eval()


def fit(name,kind,task,data,validation,epochs,resume,seed=660):
    torch.manual_seed(seed)
    model=Model(kind,task)
    optimizer=torch.optim.AdamW(model.parameters(),lr=.003)
    file=OUT/(name+".pt")
    epoch=0
    logs=[]
    if resume and file.exists():
        previous=torch.load(file,weights_only=True)
        model.load_state_dict(previous["weights"])
        optimizer.load_state_dict(previous["optimizer"])
        torch.set_rng_state(previous["rng"])
        epoch,logs=previous["epochs"],previous["history"]
    def loss(batch):
        if task=="value":
            valid=batch[1]>-99
            relative=batch[1]-batch[1][:,:1]
            weights=torch.where(relative.abs()>.1,2.,1.)
            return (nn.functional.smooth_l1_loss(model(batch[0])[valid],relative[valid],reduction="none")*
                    weights[valid]).mean()
        if task=="prior":
            return nn.functional.cross_entropy(model(batch[0]),batch[1].long())
        if task=="cause":
            return nn.functional.binary_cross_entropy_with_logits(model(batch[0]),batch[1].float())
        if task=="effect":
            estimate=model(batch[0],batch[1].long()).tanh()
            weights=1+4*(batch[2].abs()>.05)
            return (nn.functional.smooth_l1_loss(estimate,batch[2],reduction="none")*weights).mean()
        estimate=model(batch[0],batch[1].long()).sigmoid()
        return ((estimate-batch[2])**2).mean()
    for i in range(epoch,epochs):
        losses=[]
        for items in torch.randperm(len(data[0])).split(128):
            value=loss(tuple(x[items] for x in data))
            optimizer.zero_grad()
            value.backward()
            optimizer.step()
            losses.append(float(value.detach()))
        with torch.no_grad():
            val=float(loss(validation))
        logs.append({"epoch":i+1,"train_loss":float(np.mean(losses)),"validation_loss":val})
        tmp=file.with_suffix(".tmp")
        torch.save({"kind":kind,"task":task,"weights":model.state_dict(),"optimizer":optimizer.state_dict(),
                    "rng":torch.get_rng_state(),"epochs":i+1,"history":logs},tmp)
        tmp.replace(file)
    return logs


def fit_interventions(pairs):
    # A Bayesian diagnostic model from interventions: estimate likelihood of a
    # measurable treatment response given presence/absence of each root.
    features,y=(np.asarray(col) for col in zip(*pairs))
    x=(abs(features.reshape(len(features),2*ROOT_COUNT,-1))>1e-5).any(axis=-1)
    p=(y.sum(0)+1)/(len(y)+2)
    yes=((x&y).sum(0)+1)/(y.sum(0)+2)
    no=((x&~y).sum(0)+1)/((~y).sum(0)+2)
    result={"prior":p.tolist(),"response_with_root":yes.tolist(),"response_without_root":no.tolist()}
    (OUT/"interventional-bayes.json").write_text(json.dumps(result,indent=2)+"\n")
    return result


def posterior(parameters, features):
    prior=np.array(parameters["prior"])
    yes=np.array(parameters["response_with_root"])
    no=np.array(parameters["response_without_root"])
    response=(abs(features.reshape(len(features),2*ROOT_COUNT,-1))>1e-5).any(axis=-1)
    left=prior*np.where(response,yes,1-yes)
    right=(1-prior)*np.where(response,no,1-no)
    return left/(left+right)


def main(epochs,resume):
    started=perf_counter()
    train,pairs,teacher=collection(12_000,380,interventions=True,demonstrations=True)
    valid,valid_pairs,valid_teacher=collection(280_000,88,interventions=True,demonstrations=True)
    report={"train_transitions":len(train[0]),"validation_transitions":len(valid[0]),
            "train_intervention_sets":len(pairs),"validation_intervention_sets":len(valid_pairs),
            "train_demonstrations":len(teacher),"epochs":{}}
    fit_interventions(pairs)
    for kind in ("mlp","gru"):
        report["epochs"]["cause-"+kind]=fit("cause-"+kind,kind,"cause",(train[0],train[3]),(valid[0],valid[3]),epochs,resume)
    for kind in ("mlp","gru"):
        report["epochs"]["world-"+kind]=fit("world-"+kind,kind,"world",train,valid,epochs,resume)
    report["epochs"]["world-gru-b"]=fit("world-gru-b","gru","world",train,valid,epochs,resume,seed=661)
    def pack(rows):
        return tuple(torch.as_tensor(np.asarray(col)) for col in zip(*rows))
    train_teacher,valid_teacher_data=pack(teacher),pack(valid_teacher)
    report["training_action_counts"]=torch.bincount(train_teacher[1].argmax(1),minlength=N).tolist()
    report["epochs"]["planning-prior"]=fit("planning-prior","mlp","prior",
        (train_teacher[0],train_teacher[1].argmax(1)),(valid_teacher_data[0],valid_teacher_data[1].argmax(1)),epochs,resume)
    report["epochs"]["action-value"]=fit("action-value","mlp","value",train_teacher,valid_teacher_data,epochs,resume)
    report["seconds"]=perf_counter()-started
    (OUT/"training.json").write_text(json.dumps(report,indent=2)+"\n")
    print({key:value for key,value in report.items() if key!="epochs"})


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--epochs",type=int,default=12)
    parser.add_argument("--resume",action="store_true")
    args=parser.parse_args()
    main(args.epochs,args.resume)
