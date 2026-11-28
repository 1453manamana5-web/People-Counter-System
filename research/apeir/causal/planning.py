"""Bounded model-predictive planning. The simulator alone executes actions."""
import numpy as np
import torch

from train import load
from world import N, allowed


def strong_rules(obs):
    ok=allowed(obs)
    for action in (5,6,7,8,3,4):
        if ok[action]:
            return action
    disk=obs[[3,13]]
    if np.any(disk==0) and not np.any(obs[[5,15]]==1):
        return 2
    return 1 if np.any(obs[[1,2,11,12]]<0) else 0


class Planner:
    def __init__(self):
        self.ensemble=[load("world-gru"),load("world-gru-b")]
        self.prior=load("planning-prior")
        self.cause=load("cause-gru")
        self.values=load("action-value")

    @torch.inference_mode()
    def transitions(self, histories, actions):
        x=torch.from_numpy(np.asarray(histories,np.float32))
        a=torch.from_numpy(np.asarray(actions,np.int64))
        outputs=np.stack([model(x,a).sigmoid().numpy() for model in self.ensemble])
        return outputs.mean(0),outputs.std(0)

    @torch.inference_mode()
    def action_value(self, history, margin=None):
        obs=history[-1]
        baseline=strong_rules(obs)
        ok=allowed(obs)
        if margin is not None and np.count_nonzero(ok[3:])<2:
            return baseline,False
        estimate=self.values(torch.from_numpy(history[None])).numpy()[0]
        if margin is None:
            return int(np.where(ok,estimate,-np.inf).argmax()),True
        eligible=np.flatnonzero(ok[3:])+3
        candidate=int(eligible[np.argmax(estimate[eligible])])
        if candidate==baseline or estimate[candidate]<estimate[baseline]+margin:
            return baseline,True
        mu,spread=self.transitions([history,history],[candidate,baseline])
        if float(spread[:,[1,2,4,11,12,14,-1]].mean())>.09 or mu[0,-1]>mu[1,-1]+.08:
            return baseline,True
        return candidate,True

    def best(self, history, strategy="beam", prior=True, uncertainty=True):
        obs=history[-1]
        mask=allowed(obs)
        useful=np.flatnonzero(mask[3:])+3
        if not len(useful):
            return strong_rules(obs),False
        actions=[0,1,*useful.tolist()]
        with torch.inference_mode():
            encoded=torch.from_numpy(history[None])
            logits=self.prior(encoded).softmax(-1).numpy()[0] if prior else np.zeros(N)
            causes=self.cause(encoded).sigmoid().numpy()[0].reshape(2,-1)
        paths=[(history,(),0.,0.)]
        rng=np.random.default_rng(805)
        for depth in range(3):
            examples=[]
            for frames,path,cost,doubts in paths:
                for a in actions:
                    # No new control permission may be inferred from a predicted state.
                    if a>=5 and any(p>=5 and (p-5)%2==(a-5)%2 for p in path):
                        continue
                    examples.append((frames,path,a,cost,doubts))
            if strategy=="sample" and len(examples)>20:
                keep=np.sort(rng.choice(len(examples),size=20,replace=False))
                examples=[examples[i] for i in keep]
            means,std=self.transitions([x[0] for x in examples],[x[2] for x in examples])
            next_paths=[]
            for (frames,path,a,cost,doubts),estimate,spread in zip(examples,means,std):
                future=estimate[:-1].copy()
                index=[5,6,7,8,15,16,17,18]
                future[index]=obs[index]  # guard inputs never come from the predictor
                updated=np.concatenate((frames[1:],future[None]))
                risk=float(estimate[-1])+0.25*float(estimate[[4,14]].sum())
                # Prefer a short plan and break near ties using the learned prior.
                cost_new=cost+(.9**depth)*risk+.045*(a>=3)+.008*(a==1)
                if not path:
                    cost_new-=.24*float(logits[a])
                    if a>=5:
                        root=1 if a<=6 else 2
                        cost_new+=.12*(1-float(causes[(a-5)%2,root]))
                divergence=float(spread[[0,1,2,3,4,10,11,12,13,14,-1]].mean())
                next_paths.append((updated,(*path,a),cost_new,doubts+divergence))
            paths=sorted(next_paths,key=lambda item:item[2]+(.8 if uncertainty else 0)*item[3])[:4]
        result=paths[0]
        if uncertainty and result[3]/3>.11:
            return 1,True
        return int(result[1][0]),True
