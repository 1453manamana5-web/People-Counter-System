"""Holdout benchmark, controlled transfer, routing and recovery attribution."""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import resource
import tempfile
from time import perf_counter,perf_counter_ns

import numpy as np
import torch
from torch.nn import functional as F

from benchmark_world import (BenchmarkWorld, GROUPS, RECOVERABLE, SEEDS, append,
    frames_start, scenarios)
from core import DEPTHS, Decision, Intelligence, Router, routing_features, verify_operation
from learning import diagnostic, infer, load_model, read, score
from learn import reload
from memory import Archive, Search
from planning import Planner, strong_rules
from world import allowed

HERE=Path(__file__).resolve().parent


def archive():
    contents=gzip.decompress((HERE/"../continual/artifacts/episodes.json.gz").read_bytes())
    with tempfile.TemporaryDirectory() as directory:
        target=Path(directory)/"episodes.json"
        target.write_bytes(contents)
        return Search(Archive.load(target),"day-v1")


def fit_router(engine, data):
    # Independent router-training seeds. No validation/final oracle labels.
    histories,_,_,gains,masks=data
    features,labels=[],[]
    for history,gain,mask in zip(histories.numpy(),gains.numpy(),masks.numpy()):
        if not allowed(history[-1])[3:].any():
            continue
        rule=strong_rules(history[-1])
        def utility(decision):
            first=decision.action
            follow=decision.sequence[-1] if len(decision.sequence)>1 else 0
            if not mask[first,follow]:
                return -.25
            return float(np.dot(gain[first,follow],[.35,.35,.30]))-.08*int(first>=3)-.08*int(follow>=3)
        choices=[engine.decide(history,0),engine.decide(history,3),engine.decide(history,4)]
        if rule<=1 and not mask[0,0]:
            continue
        best=max(range(len(choices)),key=lambda index:utility(choices[index])-.06*index)
        features.append(routing_features(history))
        labels.append(best)
    x=torch.from_numpy(np.asarray(features))
    y=torch.tensor(labels)
    torch.manual_seed(1515)
    model=Router()
    opt=torch.optim.AdamW(model.parameters(),lr=.015)
    weights=torch.bincount(y,minlength=3).float().clamp_min(1).rsqrt()
    started=perf_counter()
    for _ in range(70):
        loss=F.cross_entropy(model(x),y,weight=weights)
        opt.zero_grad()
        loss.backward()
        opt.step()
    return model.eval(),{"training_examples":len(y),"labels":torch.bincount(y,minlength=3).tolist(),
        "seconds":perf_counter()-started,"training_match":int((model(x).argmax(1)==y).sum())}


def invoke(engine,legacy,policy,frames,referred):
    if policy=="wait":
        return 0,0,False,"wait"
    if policy=="alpha11":
        # Prior research representative used a rule plus one learned effect/value head.
        obs=frames[-1]
        rule=strong_rules(obs)
        legal=allowed(obs); candidates=np.flatnonzero(legal[3:])+3
        if not len(candidates):
            return (1 if rule==2 and referred else rule),0,False,"alpha11"
        with torch.inference_mode():
            _,_,value,effect=legacy(torch.from_numpy(frames[None,-3:]))
        estimates=value[0].numpy().copy()
        for action in candidates:
            if action>=7 and obs[((action-7)%2)*10+9]==1:
                estimates[action]-=.12
        candidate=int(candidates[estimates[candidates].argmax()])
        action=rule
        if rule not in candidates or candidate==rule or (
            estimates[candidate]>=estimates[rule]+.04 and effect[0,candidate]>=effect[0,rule]-.1):
            action=1 if rule in candidates and estimates[rule]<-.12 and estimates[candidate]<-.12 else candidate
        return action,1,False,"alpha11"
    decision=engine.decide(frames, None if policy=="learned-routing" else DEPTHS.index(policy),referred)
    return decision.action,decision.model_calls,sum(a>=3 for a in decision.sequence)>1,decision.depth


def roll(case,engine,legacy,policy):
    world=BenchmarkWorld(case)
    frames=frames_start(world)
    elapsed=[]
    output=Counter()
    depths=Counter()
    last_referral=-100
    confirmed=False
    first=None
    while not world.state.done:
        start=perf_counter_ns()
        action,calls,multi,depth=invoke(engine,legacy,policy,frames,world.state.now-last_referral<8)
        elapsed.append((perf_counter_ns()-start)/1e6)
        depths[depth]+=1
        mask=allowed(frames[-1])
        output["decisions"]+=1
        output["model_calls"]+=calls
        output["multistep_proposals"]+=multi
        output["invalid_candidates"]+=not mask[action]
        if action==2:
            last_referral=world.state.now
        event=world.step(action)
        output["blocked"]+=event["blocked"]
        output["unnecessary"]+=event["unnecessary"]
        output["operations"]+=event["action"]>=3
        output["referrals"]+=event["action"]==2
        output["removed_faults"]+=event.get("cleared",0)
        if world.initial_bad and (world.released_at is None or world.state.now>world.released_at):
            if event["restored"] and not confirmed:
                first=world.state.now
                confirmed=True
        obs=world.observe()
        if event["action"]>=3:
            verification=verify_operation(event["action"],frames[-1],obs)
            output["verification_"+verification]+=1
            if event["action"]>=5 and verification=="observed":
                side=(event["action"]-5)%2
                root=1 if event["action"]<=6 else 2
                output["false_restart_verification"]+=int(world.state.roots[side,root])
        frames=append(frames,obs)
    output["lost"]=int(world.state.lost.sum())
    output["remaining_roots"]=int(world.state.roots.sum())
    output["restored"]=int(confirmed)
    output["resolution_tick_total"]=first or 0
    return output,elapsed,depths


def evaluate_policies(engine,legacy,split):
    cases=scenarios(split)
    policies=("wait","alpha08","alpha11",*DEPTHS,"learned-routing")
    benchmark={}
    baselines={}
    for policy in policies:
        groups={name:Counter() for name in GROUPS}
        seed_groups={str(i):Counter() for i in range(3)}
        times=[]
        depth=Counter()
        for case in cases:
            if policy=="alpha08":
                planner=legacy["old_planner"]
                class Historical:
                    def decide(self,frames,depth,referred):
                        action,used=planner.action_value(frames[-3:],.1)
                        return Decision(action,(action,),DEPTHS[0],model_calls=int(used))
                totals,elapsed,chosen=roll(case,Historical(),None,"Instant")
            else:
                totals,elapsed,chosen=roll(case,engine,legacy["alpha11"],policy)
            totals["episodes"]+=1
            if case.group in RECOVERABLE:
                totals["recoverable"]+=1
                totals["recoverable_restored"]+=totals["restored"]
            if policy=="wait":
                baselines[case.seed]=totals.copy()
            baseline=baselines[case.seed]
            totals["restored_when_wait_failed"]=bool(totals["restored"] and not baseline["restored"])
            totals["lost_prevented_vs_wait"]=baseline["lost"]-totals["lost"]
            groups[case.group].update(totals)
            seed_groups[str(case.seed%3)].update(totals)
            depth.update(chosen)
            times.extend(elapsed)
        all_rows=Counter()
        for row in groups.values():
            all_rows.update(row)
        benchmark[policy]={"totals":dict(all_rows),"groups":{key:dict(value) for key,value in groups.items()},
            "seed_groups":{key:dict(value) for key,value in seed_groups.items()},
            "depth":dict(depth),"decision_p95_ms":float(np.quantile(times,.95))}
        print(split,policy,all_rows["recoverable_restored"],all_rows["recoverable"],
              all_rows["lost_prevented_vs_wait"],flush=True)
    return benchmark


def evaluate(cache,out):
    source=json.loads((out/"training.json").read_text())
    candidates={key:load_model(out/(key+".pt")) for key in source["candidates"]}
    chosen=source["chosen"]
    primary,threshold=candidates[chosen]
    ensemble=[net for name,(net,_) in candidates.items() if name!=chosen and net.kind==primary.kind]
    engine=Intelligence(primary,ensemble)
    router,router_metrics=fit_router(engine,read("router",cache)[0])
    torch.save(router.state_dict(),out/"router.pt")
    engine.router=router
    engine.memory=archive()
    old={"old_planner":Planner(),"alpha11":reload(HERE/"../continual/artifacts/joint.pt")}
    report={"model":chosen,"router":{**router_metrics,"bytes":(out/"router.pt").stat().st_size},
        "split_manifest":SEEDS,"benchmark":{}}
    validation,_,_=read("validation",cache)
    _,_,effect=infer(primary,validation[0])
    selected=validation[4].numpy().copy()
    selected[:,0,0]=False
    radius=np.quantile(abs(effect[selected]-validation[3].numpy()[selected]),.90,axis=0)
    members=[primary,*ensemble]
    def uncertainty(data):
        probabilities=np.stack([infer(net,data[0])[0] for net in members])
        return probabilities.std(0).mean(1)
    unfamiliar_limit=float(np.quantile(uncertainty(validation),.90))
    report["uncertainty_cutoff"]=unfamiliar_limit
    # Select among policies on validation seeds. Holdouts only report results.
    dry=evaluate_policies(engine,old,"validation")
    report["validation_policies"]=dry
    def rank(entry):
        row=entry[1]["totals"]
        return (row["invalid_candidates"]==0,row["recoverable_restored"],
                row["lost_prevented_vs_wait"],-row["unnecessary"],-row["model_calls"])
    report["policy_candidate"]=max(((name,row) for name,row in dry.items()
                                   if name in (*DEPTHS,"learned-routing")),key=rank)[0]

    for split in ("fixed","fresh"):
        data,tags,_=read(split,cache)
        models={name:score(model,data,limit) for name,(model,limit) in candidates.items()}
        diag={}
        with torch.inference_mode():
            old_prob=old["alpha11"](data[0][:,-3:])[0].sigmoid().numpy()
            alpha08_prob=old["old_planner"].cause(data[0][:,-3:]).sigmoid().numpy()
        diag["alpha11"]=diagnostic(old_prob,data[1].numpy(),.25)
        diag["alpha08"]=diagnostic(alpha08_prob,data[1].numpy(),.5)
        diag["groups"]={name:score(primary,tuple(row[tags==name] for row in data),threshold) for name in GROUPS}
        _,_,predicted=infer(primary,data[0])
        mask=data[4].numpy().copy()
        mask[:,0,0]=False
        error=abs(predicted[mask]-data[3].numpy()[mask])
        delta=uncertainty(data)
        flagged=delta>unfamiliar_limit
        report["benchmark"][split]={"models":models,"diagnosis":diag,
          "uncertainty":{name:{"cases":int((tags==name).sum()),"flagged":int((flagged&(tags==name)).sum())} for name in GROUPS},
          "effect_interval":{"pairs":len(error),"radius":radius.tolist(),"coverage":(error<=radius).mean(0).tolist()},
          "policies":evaluate_policies(engine,old,split)}
    report["max_rss_kib"]=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    (out/"results.json").write_text(json.dumps(report,indent=2)+"\n")


if __name__=="__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--cache",required=True,type=Path)
    cli.add_argument("--out",type=Path,default=HERE/"artifacts")
    args=cli.parse_args()
    evaluate(args.cache,args.out)
