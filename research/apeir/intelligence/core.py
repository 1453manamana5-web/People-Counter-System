"""Apeir's bounded research core. A plan is a suggestion to the simulator guard."""
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from torch import nn

from knowledge import Knowledge
from memory import Search
from planning import strong_rules
from world import N, allowed

DEPTHS=("Instant","Reasoning","Deep Reasoning","Extended Reasoning","Research")


def possible_plans(obs):
    mask=allowed(obs)
    current=np.flatnonzero(mask[3:])+3
    pairs=[(0,0),*((int(a),0) for a in current)]
    for first in (0,*current):
        for second in current:
            if first==second and first>=5:
                continue
            pairs.append((int(first),int(second)))
        if first in (5,6):
            # A successful camera recovery can expose the underlying engine.
            # This is only a future candidate and must be rechecked on new data.
            pairs.append((int(first),int(first)+2))
    return pairs


def routing_features(history):
    obs=history[-1]
    mask=allowed(obs)
    return np.asarray([1- (history>=0).mean(), (obs[[0,1,2,3,10,11,12,13]]==0).mean(),
      np.count_nonzero(mask[3:])/6, (obs[[4,14]].clip(0,1)).mean(),
      (abs(history[-1]-history[0])>.3).mean(), np.count_nonzero(mask[5:])/4],np.float32)


class Router(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers=nn.Sequential(nn.Linear(6,16),nn.SiLU(),nn.Linear(16,3))

    def forward(self,value):
        return self.layers(value)


@dataclass
class Decision:
    action:int
    sequence:tuple
    depth:str
    evidence:tuple=()
    uncertainty:float|None=None
    model_calls:int=0


class Intelligence:
    def __init__(self, primary, ensemble, router=None, memory:Search|None=None, knowledge:Knowledge|None=None):
        self.primary=primary
        self.ensemble=ensemble
        self.router=router
        self.memory=memory
        self.knowledge=knowledge

    def explain(self,goal,value):
        return self.knowledge.answer(goal,value) if self.knowledge else None

    @torch.inference_mode()
    def choose_depth(self, history):
        obs=history[-1]
        if not allowed(obs)[3:].any():
            return 1 if np.any(obs[[0,1,2,3,10,11,12,13]]<=0) else 0
        if self.router is None:
            return 3
        index=int(self.router(torch.from_numpy(routing_features(history))).argmax())
        return (0,3,4)[index]

    @torch.inference_mode()
    def decide(self,history,depth=None,referred=False):
        depth=self.choose_depth(history) if depth is None else depth
        obs=history[-1]
        fallback=strong_rules(obs)
        if fallback==2 and referred:
            fallback=1
        legal=allowed(obs)
        name=DEPTHS[depth]
        if depth==0:
            return Decision(fallback,(fallback,),name)
        batch=torch.from_numpy(history[None])
        diag,_,effects=self.primary(batch)
        scores=diag[0].sigmoid().numpy()
        plausible=tuple(int(root) for root in np.flatnonzero(scores>=.4))
        if depth==1:
            return Decision(fallback,(fallback,),name,plausible,model_calls=1)
        # The sensor evidence can exclude impossible hypotheses about a camera
        # or link. Recognition outages may still come from load or software.
        plausible=tuple(root for root in plausible if not (root%5 in (0,1,3)
            and obs[(root//5)*10+{0:0,1:1,3:3}[root%5]]==1))
        if depth==2 or not legal[3:].any():
            return Decision(fallback,(fallback,),name,plausible,model_calls=1)
        plan=possible_plans(obs)
        estimate=effects.numpy()[0]
        estimates=np.asarray([estimate[first,follow] for first,follow in plan])
        if depth==4:
            others=[net(batch)[2].numpy()[0] for net in self.ensemble]
            matrix=np.stack([estimates,*[np.array([arr[first,follow] for first,follow in plan]) for arr in others]])
            uncertainty=matrix.std(0)
            ev=matrix.mean(0)-.55*uncertainty
            if self.memory and np.any((scores>=.25)&(scores<=.55)):
                history3=history[-3:]
                related,distance=self.memory.find(history3)
                if related and distance<.12:
                    support=np.mean([row.roots for row in related],0)
                    plausible=tuple(root for root in plausible if support[root]>=.15 or scores[root]>=.65)
        else:
            uncertainty=np.zeros_like(estimates)
            ev=estimates
        cost=np.array([.09*int(first>=3)+.12*int(follow>=3)+.025*int(first==0 and follow!=0)
                       for first,follow in plan])
        utility=ev @ np.array([.35,.35,.30])-cost
        pick=int(utility.argmax())
        action,follow=plan[pick]
        if (utility[pick]<.08 or (action>0 and not legal[action])):
            action,follow=fallback,0
        if action==0 and follow==0 and fallback>=3 and utility[pick]<.14:
            action=fallback
        return Decision(action,(action,follow),name,plausible,
                        float(uncertainty[pick].mean()),1+(len(self.ensemble) if depth==4 else 0))


def load_router(path:Path):
    model=Router()
    model.load_state_dict(torch.load(path,weights_only=True))
    return model.eval()



def verify_operation(action, before, after):
    """A missing postcondition remains unverified, even if expected to succeed."""
    if not 3<=action<N:
        raise ValueError("Expected an operation")
    side=(action-3)%2
    offset=side*10
    if action<=4:
        if min(before[offset+4],after[offset+4],before[20+side],after[20+side])<0:
            return "unknown"
        return "observed" if (after[offset+4]<before[offset+4] and after[20+side]>before[20+side]) else "pending"
    index=offset+(1 if action<=6 else 2)
    if after[index]<0:
        return "unknown"
    return "observed" if after[index]==1 else "pending"
