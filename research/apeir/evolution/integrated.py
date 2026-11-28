"""A learned cascade that can stop after rules, call diagnosis, or call RL."""
import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import DQN, PPO
from torch import nn

from reinforcement import rl_action, validation
from supervised import atomic_save, decision, load
from world import ApeirWorld, guarded, rules


@dataclass
class EpisodeMemory:
    last_action: int = 0
    predicted_risk: float = 0
    used: int = 0

    def features(self):
        return np.array([self.last_action/4,self.predicted_risk,min(8,self.used)/8],dtype=np.float32)


def choose_experts(root):
    deep = [load(root/(name+".pt")) for name in ("mlp","gru","lstm")]
    best = min(deep,key=lambda item:(item[1]["validation_risk"],item[1]["validation_loss"]))
    candidates = [(name,cls.load(root/(name+"-latest.zip"),device="cpu")) for name,cls in (("ppo",PPO),("dqn",DQN))]
    name, policy = max(candidates,key=lambda item:validation(item[1]))
    return best, name, policy


def cheap_features(obs, memory):
    latest = obs[-1]
    recent = obs[:,:6]
    return np.concatenate((latest, (recent==0).mean(0), (recent<0).mean(0), memory.features())).astype(np.float32)


def refinement_features(first, proposal, confidence, forecast, risk):
    return np.concatenate((first,np.array([proposal/4,confidence,forecast,risk],dtype=np.float32)))


def cascade_net(size):
    return nn.Sequential(nn.Linear(size,24),nn.ReLU(),nn.Linear(24,1),nn.Flatten(0))


class Cascade:
    def __init__(self, root, *, use_rl=True):
        state=torch.load(root/"alpha05.pt",weights_only=True)
        self.scout=cascade_net(26)
        self.refine=cascade_net(30)
        self.scout.load_state_dict(state["scout"])
        self.refine.load_state_dict(state["refine"])
        self.cuts=state["cuts"]
        self.expert=load(root/(state["architecture"]+".pt"))
        self.policy=({"ppo":PPO,"dqn":DQN}[state["policy"]].load(
            root/(state["policy"]+"-latest.zip"),device="cpu") if use_rl else None)

    @torch.inference_mode()
    def decide(self, obs, memory, *, ablation="none"):
        features=cheap_features(obs, memory if ablation!="no-memory" else EpisodeMemory())
        fallback, diag, anomaly = rules(obs)
        shortcut = float(self.scout(torch.from_numpy(features)).sigmoid()[0]) < self.cuts[0]
        if ablation!="always-deep" and shortcut:
            action, depth, forecast, risk = fallback, 0, float(anomaly), float(anomaly)
        else:
            proposed, diag, anomaly, confidence, forecast, risk = decision(self.expert,obs)
            action,depth=proposed,1
            if self.policy is not None and ablation!="no-rl":
                next_features=refinement_features(features,proposed,confidence,forecast,risk)
                wants_rl=float(self.refine(torch.from_numpy(next_features)).sigmoid()[0]) >= self.cuts[1]
                if wants_rl:
                    action,depth=rl_action(self.policy,obs),2
        action=guarded(obs,action)
        memory.last_action, memory.predicted_risk, memory.used = action, forecast, memory.used+1
        return action, diag, anomaly, depth, risk


def rows(expert, policy, start, count):
    rng = np.random.default_rng(start)
    stages=[[],[]]
    env=ApeirWorld(distribution="novel" if start>=210_000 else "train")
    for seed in range(start,start+count):
        obs,_=env.reset(seed=seed)
        mem=EpisodeMemory()
        while True:
            first=cheap_features(obs,mem)
            fallback,fault,problem=rules(obs)
            proposed,diag,anomaly,confidence,forecast,risk=decision(expert,obs)
            deep=guarded(obs,proposed)
            rl=rl_action(policy,obs)
            teacher=env.teacher()
            actual_problem=bool(env.faults.any() or env.durable)
            def cost(action, detected, detected_faults):
                return (float(action!=teacher)+10*float(actual_problem and not detected)+
                        .4*float(not actual_problem and detected)+.25*np.count_nonzero(detected_faults!=env.faults))
            cheap_loss=cost(fallback,problem,fault)
            deep_loss=cost(deep,anomaly,diag)
            rl_loss=cost(rl,anomaly,diag)
            gain=cheap_loss-min(deep_loss,rl_loss+.1)
            more=deep_loss-rl_loss
            stages[0].append((first,gain>.1,abs(gain)+1))
            stages[1].append((refinement_features(first,proposed,confidence,forecast,risk),more>.1,abs(more)+1))
            action=int(rng.choice([fallback,deep,rl,teacher]))
            mem.last_action,mem.predicted_risk,mem.used=action,forecast,mem.used+1
            obs,_,end,truncate,_=env.step(action)
            if end or truncate:
                break
    return [tuple(torch.tensor(np.asarray(col)) for col in zip(*stage)) for stage in stages]


def train(root, resume=False):
    torch.manual_seed(5005)
    expert,name,policy=choose_experts(root)
    train_rows=rows(expert,policy,52_000,1200)
    validated=rows(expert,policy,210_000,320)
    payload={"architecture":expert[1]["architecture"],"policy":name,"cuts":[]}
    path=root/"alpha05.pt"
    previous=torch.load(path,weights_only=True) if resume and path.exists() else None
    for stage, key in enumerate(("scout","refine")):
        x,y,w=train_rows[stage]
        net=cascade_net(x.shape[1])
        opt=torch.optim.AdamW(net.parameters(),lr=.003)
        if previous and previous["architecture"]==payload["architecture"] and previous["policy"]==name:
            net.load_state_dict(previous[key])
            opt.load_state_dict(previous[key+"_optimizer"])
        for _ in range(12):
            for batch in torch.randperm(len(x)).split(192):
                objective=nn.functional.binary_cross_entropy_with_logits(net(x[batch]),y[batch].float(),weight=w[batch].float())
                opt.zero_grad()
                objective.backward()
                opt.step()
        with torch.no_grad():
            vx,vy,vw=validated[stage]
            score=net(vx).sigmoid()
            cut=min((.2,.35,.5,.65,.8),key=lambda t:float((vw*((score>=t)!=vy)).sum()))
        payload.update({key:net.state_dict(),key+"_optimizer":opt.state_dict()})
        payload["cuts"].append(cut)
    atomic_save(payload,path)
    print({"architecture":payload["architecture"],"policy":name,"cuts":payload["cuts"],
           "router_training_decisions":len(train_rows[0][0]), "router_validation_decisions":len(validated[0][0])})


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--resume",action="store_true")
    a=p.parse_args()
    train(a.out,a.resume)
