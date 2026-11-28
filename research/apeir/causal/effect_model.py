"""Direct paired-effect learning compared with predicting no effect."""
import argparse
from copy import deepcopy
import json
import numpy as np
import torch

from evaluate import FOCUS, forward
from train import HISTORY, OUT, fit, load, target
from world import World, allowed, rules

FRESH=(1_201_000,1_227_000,1_263_000)


def collect(start, episodes, profile):
    rows=[]
    for seed in range(start,start+episodes):
        w=World(seed,profile)
        frames=[w.observe()]*HISTORY
        while not w.state.done:
            h=np.stack(frames[-HISTORY:])
            actions=np.flatnonzero(allowed(h[-1])[3:])+3
            if len(actions):
                reference=deepcopy(w)
                reference.step(0)
                after=target(reference)
                for action in actions:
                    intervention=deepcopy(w)
                    intervention.step(int(action))
                    rows.append((h,int(action),target(intervention)-after))
            w.step(rules(h[-1]))
            frames.append(w.observe())
    return tuple(torch.as_tensor(np.asarray(col)) for col in zip(*rows))


def main(epochs,resume,train_only=False):
    training=collect(460_000,420,"standard")
    validation=collect(490_000,90,"standard")
    history=fit("paired-effect","mlp","effect",training,validation,epochs,resume)
    if train_only:
        return
    pair=load("paired-effect")
    transitions=load("world-gru")
    report={"training_pairs":len(training[0]),"validation_pairs":len(validation[0]),
            "history":history,"seeds":FRESH,"cohorts":{}}
    for profile in ("standard","school","busy"):
        folds=[]
        for seed in FRESH:
            x,a,y=collect(seed,18,profile)
            with torch.inference_mode():
                direct=pair(x,a.long()).tanh().numpy()
            inferred=np.asarray([forward(transitions,h,int(i))-forward(transitions,h,0) for h,i in zip(x,a)])
            y=y.numpy()
            folds.append({"seed":seed,"cases":len(x),
                          "direct_mae":float(np.abs(direct[:,FOCUS]-y[:,FOCUS]).mean()),
                          "world_difference_mae":float(np.abs(inferred[:,FOCUS]-y[:,FOCUS]).mean()),
                          "zero_mae":float(np.abs(y[:,FOCUS]).mean())})
        report["cohorts"][profile]=folds
    (OUT/"paired-effect-results.json").write_text(json.dumps(report,indent=2)+"\n")


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--epochs",type=int,default=12)
    p.add_argument("--resume",action="store_true")
    p.add_argument("--train-only",action="store_true")
    a=p.parse_args()
    main(a.epochs,a.resume,a.train_only)
