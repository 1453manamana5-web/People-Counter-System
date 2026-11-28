"""Replay archived α-04 policies against the original simulator controls."""
from copy import deepcopy
import json

import numpy as np

from legacy import MODEL_ROOT, previous, reinforcement
from train import OUT, collection


def run():
    report={}
    for profile in ("train","novel"):
        data={"decisions":0,"active_options":0,"healthy_decisions":0,"with_prior_incident":0,
              "defer_better_immediate":0,"defer_better_three_steps":0,
              "raw_blocked":{"ppo":0,"dqn":0},"masked_moved":{"ppo":0,"dqn":0}}
        models={name:cls.load(MODEL_ROOT/"artifacts"/(name+"-latest.zip"),device="cpu")
                for name,cls in (("ppo",reinforcement.PPO),("dqn",reinforcement.DQN))}
        env=previous.ApeirWorld(distribution=profile)
        for seed in range(330_000,330_120):
            obs,_=env.reset(seed=seed)
            while True:
                data["decisions"]+=1
                data["healthy_decisions"]+=not bool(env.faults.any() or env.durable)
                data["with_prior_incident"]+=env.initial_problem
                permitted=reinforcement.permitted(obs)
                moves=np.flatnonzero(permitted)[1:]
                moves=moves[(moves>=1)&(moves<=3)]
                if len(moves):
                    data["active_options"]+=1
                    clone=deepcopy(env)
                    _,ask_reward,*_=clone.step(4)
                    direct,long=[],[]
                    for move in moves:
                        clone=deepcopy(env)
                        _,reward,t,u,_=clone.step(int(move))
                        direct.append(reward)
                        for _ in range(2):
                            if t or u:
                                break
                            _,part,t,u,_=clone.step(clone.teacher())
                            reward+=part
                        long.append(reward)
                    data["defer_better_immediate"]+=ask_reward>max(direct)
                    data["defer_better_three_steps"]+=ask_reward>max(long)
                for name,model in models.items():
                    a=int(model.predict(obs,deterministic=True)[0])
                    data["raw_blocked"][name]+=not bool(permitted[a])
                    data["masked_moved"][name]+=int(reinforcement.rl_action(model,obs) in (1,2,3))
                obs,_,t,u,_=env.step(env.teacher())
                if t or u:
                    break
        report[profile]=data
    _,_,demos=collection(12000,380,demonstrations=True)
    report["new_demonstration_actions"]=np.bincount([int(a.argmax()) for _,a in demos],minlength=9).tolist()
    (OUT/"rl-inspection.json").write_text(json.dumps(report,indent=2,default=int)+"\n")
    print(report)


if __name__=="__main__":
    run()
