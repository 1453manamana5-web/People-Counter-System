"""Frozen, seed-disjoint comparison of decisions and intervention rollouts."""
import argparse
import json
import resource
import subprocess
import sys
from pathlib import Path
from time import perf_counter_ns

import numpy as np
import torch
from stable_baselines3 import DQN, PPO

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from train import probabilities, encode  # α-02 shares the original encoding.

from integrated import Cascade, EpisodeMemory
from reinforcement import rl_action
from supervised import decision, load
from world import Action, ApeirWorld, TEST_START, guarded, permitted, rules

METHODS = ("rules","alpha02","mlp","gru","lstm","ppo","dqn","alpha05","no-memory","always-deep","no-rl")
# No training script imports this file or uses these cohort seeds.
SEEDS = (TEST_START,TEST_START+20_000,TEST_START+40_000)
EPISODES = 120


def alpha02(path):
    data=json.loads(path.read_text())
    weights=np.asarray(data["weights"])
    threshold=data["threshold"]
    def predict(obs,_memory):
        legacy=obs[:,[0,1,3,4,5,7]]
        scores=probabilities(encode(legacy.reshape(1,-1))@weights)[0]
        label=int(scores.argmax())
        clean=np.all(legacy==[1,1,1,1,0,1],axis=1)
        if scores[label]<threshold or legacy[-1,-1]!=1 or label==0 and not (clean[-1] and clean[:-1].any()):
            label=4
        mask=permitted(obs)
        action=({0:Action.WAIT,1:Action.SYNC if mask[1] else Action.WAIT,
                 2:Action.CAMERA if mask[2] else Action.ENGINE if mask[3] else Action.WAIT,
                 3:Action.ASK,4:Action.ASK})[label]
        fault=np.array([label==1,label==2 and obs[-1,1]==0,label==2 and obs[-1,2]==0,label==3])
        return int(action),fault,label!=0,0,float(1-scores[0])
    return predict,weights.nbytes


def init(method, root):
    if method=="rules":
        def run(obs,_mem):
            act,diag,risk=rules(obs)
            return act,diag,risk,0,float(risk)
        return run,0
    if method=="alpha02":
        return alpha02(Path(__file__).resolve().parents[1]/"alpha02-weights.json")
    if method in ("mlp","gru","lstm"):
        bundle=load(root/(method+".pt"))
        def run(obs,_mem):
            action,detection,problem,_confidence,_future,risk=decision(bundle,obs)
            return action,detection,problem,1,risk
        return run, parameter_bytes(bundle[0])
    if method in ("ppo","dqn"):
        policy={"ppo":PPO,"dqn":DQN}[method].load(root/(method+"-latest.zip"),device="cpu")
        def run(obs,_mem):
            _,fault,problem=rules(obs)
            return rl_action(policy,obs),fault,problem,2,float(problem)
        return run,parameter_bytes(policy.policy)
    cascade=Cascade(root,use_rl=method!="no-rl")
    loaded=[cascade.scout,cascade.refine,cascade.expert[0]]
    if cascade.policy is not None:
        loaded.append(cascade.policy.policy)
    return lambda obs,mem: cascade.decide(obs,mem,ablation="none" if method=="alpha05" else method),sum(
        parameter_bytes(item) for item in loaded)


def parameter_bytes(module):
    # Count inference weights and registered buffers, excluding optimizer state.
    return sum(t.nelement()*t.element_size() for t in (*module.parameters(),*module.buffers()))


def evaluate_one(method,root):
    run, size = init(method,root)
    observations = {}
    latency = []
    familiar_correct = []
    for cohort in ("familiar","novel"):
        rows=[]
        for start in SEEDS:
            total={key:0 for key in ("decisions","correct","fault_exact","anomalies","missed","asked",
                    "unattended_correct","weighted","blocked","ep_fault","restored","moves","unnecessary","captures_lost")}
            total["risk_brier"]=0.
            total["return"]=0.
            depths=[0,0,0]
            calibration=[[] for _ in range(10)]
            for seed in range(start,start+EPISODES):
                # All methods receive the same reference-driven observation sequence.
                dist="train" if cohort=="familiar" else "novel"
                env=ApeirWorld(distribution=dist)
                obs,_=env.reset(seed=seed)
                mem=EpisodeMemory()
                while True:
                    t=perf_counter_ns()
                    raw,diag,alarm,depth,risk=run(obs,mem)
                    latency.append((perf_counter_ns()-t)/1e6)
                    choice=guarded(obs,raw)
                    ref=env.teacher()
                    mem.last_action=ref
                    correct=choice==ref
                    if cohort=="familiar":
                        familiar_correct.append(correct)
                    obs,_,end,trunc,info=env.step(ref)
                    problem=info["problem"]
                    total["decisions"]+=1
                    total["correct"]+=int(correct)
                    total["fault_exact"]+=int(np.array_equal(diag,info["faults"]))
                    total["anomalies"]+=int(problem)
                    total["missed"]+=int(problem and not alarm)
                    total["asked"]+=int(choice==Action.ASK)
                    total["unattended_correct"]+=int(choice!=Action.ASK and correct)
                    total["weighted"]+=int(not correct)+10*int(problem and not alarm)
                    total["blocked"]+=int(choice!=raw)
                    total["risk_brier"]+=(risk-int(problem))**2
                    calibration[min(9,int(risk*10))].append((risk,int(problem)))
                    depths[depth]+=1
                    if end or trunc:
                        break
                # Only this second pass tests the policy's own recovery decisions.
                obs,_=env.reset(seed=seed)
                mem=EpisodeMemory()
                total["ep_fault"]+=int(env.initial_problem)
                while True:
                    raw,*_=run(obs,mem)
                    action=guarded(obs,raw)
                    obs,reward,end,trunc,info=env.step(action)
                    total["return"]+=reward
                    total["moves"]+=int(action in (Action.SYNC,Action.CAMERA,Action.ENGINE))
                    total["unnecessary"]+=int(info["unnecessary"])
                    if end or trunc:
                        total["restored"]+=int(env.initial_problem and info["recovered"])
                        total["captures_lost"]+=env.lost
                        break
            n=total["decisions"]
            total["calibration_ece"]=sum(len(bucket)*abs(np.mean([x[0] for x in bucket])-
                np.mean([x[1] for x in bucket])) for bucket in calibration if bucket)/n
            rows.append({"seed_start":start,"episodes":EPISODES,**total,"depths":depths})
        observations[cohort]=rows
    return {"method":method,"cohorts":observations,"p50_ms":float(np.quantile(latency,.5)),
            "p95_ms":float(np.quantile(latency,.95)),"peak_rss_kib":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "weight_bytes":size,"familiar_correct":familiar_correct}


def fractions(rows):
    total={key:sum(row[key] for row in rows) for key in rows[0] if key not in ("depths","seed_start")}
    n=total["decisions"]
    return {"episodes":total["episodes"],"decisions":n,"accuracy":total["correct"]/n,
            "miss_rate":total["missed"]/max(1,total["anomalies"]),"misses":total["missed"],
            "anomalies":total["anomalies"],"fault_exact":total["fault_exact"]/n,
            "recovery":total["restored"]/max(1,total["ep_fault"]),
            "unnecessary":total["unnecessary"]/total["moves"] if total["moves"] else None,
            "unnecessary_count":total["unnecessary"],"moves":total["moves"],
            "ask_rate":total["asked"]/n,"unattended_accuracy":total["unattended_correct"]/max(1,n-total["asked"]),
            "weighted_per_1000":1000*total["weighted"]/n,"blocked_proposals":total["blocked"],
            "mean_return":total["return"]/total["episodes"],"risk_brier":total["risk_brier"]/n,
            "risk_ece_mean":total["calibration_ece"]/len(rows),
            "depth_rates":[sum(row["depths"][i] for row in rows)/n for i in range(3)]}


def main(root):
    methods={}
    for name in METHODS:
        payload=subprocess.check_output([sys.executable,__file__,"--out",str(root),"--one",name],text=True)
        result=json.loads(payload)
        result["summary"]={key:fractions(rows) for key,rows in result["cohorts"].items()}
        methods[name]=result
        print(name,result["summary"]["novel"],flush=True)
    prior=np.array(methods["alpha02"]["familiar_correct"],dtype=bool)
    for result in methods.values():
        correct=np.array(result.pop("familiar_correct"),dtype=bool)
        result["familiar_retention"]={"retained":int((prior&correct).sum()),"prior_correct":int(prior.sum()),
                                      "rate":float((prior&correct).sum()/prior.sum())}
    (root/"evaluation.json").write_text(json.dumps({"cohort_seeds":SEEDS,"methods":methods},indent=2)+"\n")


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--one",choices=METHODS)
    args=p.parse_args()
    if args.one:
        print(json.dumps(evaluate_one(args.one,args.out.resolve())))
    else:
        main(args.out)
