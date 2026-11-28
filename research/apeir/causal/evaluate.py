"""Disjoint final seeds, counterfactual pairs, and actual simulator executions."""
from copy import deepcopy
import json
import resource
from time import perf_counter_ns

import numpy as np
import torch

from legacy import Legacy
from planning import Planner,strong_rules
from train import HISTORY, OUT, contrast, load, posterior, target, action_scores
from world import ROOTS, World, allowed, rules

SEEDS=(910_000,940_000,970_000)
PROFILES=("standard","school","busy")
FOCUS=[0,1,2,3,4,9,10,11,12,13,14,19,20,21,22,23]


def fixed_episodes(seeds=SEEDS):
    for profile in PROFILES:
        for seed in seeds:
            for offset in range(18):
                yield (profile,seed,seed+offset)


def forward(model, history, action):
    with torch.inference_mode():
        return model(torch.as_tensor(np.asarray(history,np.float32)[None]),
                     torch.tensor([action])).sigmoid().numpy()[0]


def diag(model,history):
    with torch.inference_mode():
        return model(torch.from_numpy(history[None])).sigmoid().numpy()[0]


def score_diagnosis(results):
    out={}
    for name, rows in results.items():
        y,p=np.array([pair[0] for pair in rows]),np.array([pair[1] for pair in rows])
        found=p>=.5
        out[name]={"cases":len(y),"exact":float((found==y).all(1).mean()),
                   "brier":float(((p-y)**2).mean()),
                   "missed_anomalies":int((y.any(1)&~found.any(1)).sum()),
                   "anomaly_cases":int(y.any(1).sum()),
                   "by_cause":{
                       root:{"positives":int(y[:,[i,i+5]].sum()),
                             "recall":float((found[:,[i,i+5]]&y[:,[i,i+5]]).sum()/max(1,y[:,[i,i+5]].sum()))}
                       for i, root in enumerate(ROOTS)}}
    return out


def fit_interval(model):
    errors=[]
    for seed in range(300_000,300_096):
        w=World(seed,"standard")
        history=np.stack([w.observe()]*HISTORY)
        a=strong_rules(history[-1])
        if a==2:
            a=1
        pred=forward(model,history,a)
        w.step(a)
        errors.append(np.abs(pred-target(w)))
    return np.quantile(errors,.90,axis=0)


def scientific(planner):
    diagnostics={"observation-rule":[],"cause-mlp":[],"cause-gru":[],"interventional-bayes":[]}
    models={name:load(name) for name in ("cause-mlp","cause-gru","world-mlp","world-gru")}
    parameters=json.loads((OUT/"interventional-bayes.json").read_text())
    intervals=fit_interval(models["world-gru"])
    prediction={p:{name:{str(h):[] for h in (1,3,6)} for name in ("persistence","world-mlp","world-gru")} for p in PROFILES}
    effects={p:[] for p in PROFILES}
    root_effects={p:[] for p in PROFILES}
    coverage=[]
    for profile,_,seed in fixed_episodes():
        w=World(seed,profile)
        frames=[w.observe()]*HISTORY
        # Diagnose after two observations, preserving the initial history.
        for _ in range(2):
            w.step(0)
            frames.append(w.observe())
            if w.state.done:
                break
        if w.state.done:
            w=World(seed,profile)
            frames=[w.observe()]*HISTORY
        history=np.stack(frames[-HISTORY:])
        truth=w.state.roots.flatten().copy()
        with_do=contrast(w)
        for key,p in (
            ("observation-rule",np.asarray([(row[i]==0) if i!=4 else row[9]==1 for row in
                                           (history[-1,:10],history[-1,10:20]) for i in (0,1,2,3,4)],float)),
            ("cause-mlp",diag(models["cause-mlp"],history)),
            ("cause-gru",diag(models["cause-gru"],history)),
            ("interventional-bayes",posterior(parameters,with_do[None])[0]),
        ):
            diagnostics[key].append((truth,p))

        for action in np.flatnonzero(allowed(history[-1])[3:])+3:
            fixed,wait=deepcopy(w),deepcopy(w)
            fixed.step(int(action)); wait.step(0)
            observed=target(fixed)-target(wait)
            mu,spread=planner.transitions([history,history],[action,0])
            estimate=mu[0]-mu[1]
            effects[profile].append((float(np.abs(estimate[FOCUS]-observed[FOCUS]).mean()),
                                     float(np.abs(observed[FOCUS]).mean()),float(spread.mean())))
        root_effects[profile].append(int(np.count_nonzero((np.abs(with_do.reshape(10,-1))>1e-5).any(1))))

        predictions={key:history.copy() for key in ("world-mlp","world-gru")}
        base=np.clip(np.r_[history[-1],float(np.any(history[-1][[0,1,2,3,10,11,12,13]]==0))],0,1)
        for step in range(1,7):
            chosen=rules(w.observe())
            output={key:forward(models[key],past,chosen) for key,past in predictions.items()}
            for key,estimate in output.items():
                predictions[key]=np.concatenate((predictions[key][1:],estimate[:-1][None]))
            w.step(chosen)
            known=target(w)
            if step in (1,3,6):
                for key,value in {"persistence":base,**output}.items():
                    prediction[profile][key][str(step)].append(float(np.abs(value[FOCUS]-known[FOCUS]).mean()))
            if step==1:
                coverage.append(float((np.abs(output["world-gru"]-known)<=intervals+1e-7).mean()))
            if w.state.done:
                break
    def means(values):
        return {"cases":len(values),"mae":float(np.mean(values)) if values else None}
    return {"diagnosis":score_diagnosis(diagnostics),
            "world_mae":{p:{m:{h:means(v) for h,v in horizon.items()} for m,horizon in d.items()} for p,d in prediction.items()},
            "intervention_active_roots_mean":{p:float(np.mean(x)) for p,x in root_effects.items()},
            "action_effect":{p:{"cases":len(x),"mae":float(np.mean(np.array(x)[:,0])),
                                 "zero_effect_mae":float(np.mean(np.array(x)[:,1])),
                                 "mean_ensemble_spread":float(np.mean(np.array(x)[:,2]))} for p,x in effects.items()},
            "one_step_interval_target":.90,"one_step_interval_coverage":float(np.mean(coverage)),
            "interval_half_widths":intervals.tolist()}


def policy_runs(planner, name, legacy=None, validation=False, seeds=SEEDS, margin=None):
    totals={}
    durations=[]
    episodes=fixed_episodes(seeds) if not validation else (
        (p,310_000,s) for p in PROFILES for s in range(310_000,310_028))
    for profile,seed_group,seed in episodes:
        w=World(seed,profile)
        memory=legacy.memories() if legacy else None
        key=f"{profile}:{seed_group}"
        row=totals.setdefault(key,{key:0 for key in (
            "episodes","initial_fault","restored","decisions","reference_agreement","moves","eligible",
            "eligible_restarts","restarts","unnecessary","blocked","human","planner_calls","lost",
            "compound","compound_restored","multiaction_restored")})
        row["episodes"]+=1
        row["initial_fault"]+=int(w.initial_bad)
        compound=bool(w.state.roots.sum()>=2)
        row["compound"]+=compound
        frames=[w.observe()]*HISTORY
        moves=0
        while not w.state.done:
            history=np.stack(frames[-HISTORY:])
            start=perf_counter_ns()
            called=False
            if legacy:
                a,_=legacy.act(history,memory)
            elif name=="rules":
                a=strong_rules(history[-1])
            elif name in ("value","guarded-value"):
                a,called=planner.action_value(history,margin if name=="guarded-value" else None)
            elif name=="learned-prior":
                with torch.inference_mode():
                    logits=planner.prior(torch.from_numpy(history[None])).numpy()[0]
                a=int(np.where(allowed(history[-1]),logits,-np.inf).argmax())
            else:
                a,called=planner.best(history,"sample" if name=="sample" else "beam",
                                      prior=name!="beam-no-prior",uncertainty=name!="beam-no-uncertainty")
            durations.append((perf_counter_ns()-start)/1e6)
            # All policies see the same privileged scorer definition, not its result.
            scores=action_scores(w,history[-1])
            row["reference_agreement"]+=int(scores[a]>=scores.max()-.03)
            row["decisions"]+=1
            row["planner_calls"]+=called
            valid=allowed(history[-1])
            row["eligible"]+=int(valid[3:].any())
            row["eligible_restarts"]+=int(valid[5:].any())
            event=w.step(a)
            row["blocked"]+=event["blocked"]
            row["unnecessary"]+=event["unnecessary"]
            row["human"]+=int(event["action"]==2)
            row["restarts"]+=int(event["action"]>=5)
            moves+=int(event["action"]>=3)
            frames.append(w.observe())
        restored=w.initial_bad and w.state.stable==2
        row["restored"]+=restored
        row["compound_restored"]+=int(restored and compound)
        row["multiaction_restored"]+=int(restored and moves>1)
        row["lost"]+=w.state.lost.sum().item()
        row["moves"]+=moves
    sumrow={key:sum(int(row[key]) for row in totals.values()) for key in next(iter(totals.values()))}
    return {"summary":sumrow,"groups":totals,"p95_ms":float(np.quantile(durations,.95))}


def main():
    planner=Planner()
    modes=("rules","learned-prior","beam","sample","beam-no-prior","beam-no-uncertainty",
           "alpha03","alpha04-dqn","alpha05")
    # Four controlled validation toggles. No final scores select any checkpoint.
    val={name:policy_runs(planner,name,validation=True) for name in ("rules","learned-prior","beam","beam-no-prior")}
    (OUT/"validation.json").write_text(json.dumps(val,indent=2)+"\n")
    report={"seeds":SEEDS,"profiles":PROFILES,**scientific(planner),"policies":{}}
    for name in modes:
        report["policies"][name]=policy_runs(planner,name,Legacy(name) if name.startswith("alpha") else None)
        print(name,report["policies"][name]["summary"],flush=True)
    report["peak_rss_kib"]=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    (OUT/"results.json").write_text(json.dumps(report,indent=2)+"\n")


if __name__=="__main__":
    main()
