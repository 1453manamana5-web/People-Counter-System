"""Reproduce α-09 through α-11 on disjoint synthetic scenario seeds."""
import argparse
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path
import resource

import numpy as np
import torch

from day import PROFILES, VERSION
from evaluate import archive_scores, closed_loop, effect_interval, fixed_rows, forecast_rollout, for_groups, threshold_for, weaknesses
from learn import Learner, Samples, fit, generate, reload
from memory import Archive, Search
from planning import Planner
from world import ACTIONS

torch.set_num_threads(1)


def dump(path,data):
    temporary = path.with_suffix(".part")
    temporary.write_text(json.dumps(data,indent=2)+"\n")
    temporary.replace(path)


def sizes(rows):
    labels, counts = np.unique(rows.tags, return_counts=True)
    return dict(zip(labels.tolist(), counts.tolist()))


def learn(out):
    archive = Archive(1200)
    past = generate(("short","festival"), 900000, 64, archive)
    future = generate(("wireless",), 910000, 56, archive)
    source = out/"episodes.json"
    archive.save(source)
    size = source.stat().st_size
    (out/"episodes.json.gz").write_bytes(gzip.compress(source.read_bytes(),mtime=0))
    restored = Archive.load(source)
    source.unlink()
    if archive.active.keys()!=restored.active.keys() or archive.archived.keys()!=restored.archived.keys():
        raise RuntimeError("Archive changed during storage round trip")
    archive = restored
    old_dev = generate(("short","festival"), 920000, 19)
    new_dev = generate(("wireless",), 921000, 19)
    dev = Samples.join(old_dev,new_dev)
    history = {"data":{"initial":sizes(past), "adaptation":sizes(future), "validation":sizes(dev)},
               "memory":{"active":len(archive.active),"archived":len(archive.archived),
                         "serious_retained":sum(x.serious for x in (*archive.active.values(),*archive.archived.values())),
                         "json_bytes":size,"gzip_bytes":(out/"episodes.json.gz").stat().st_size}}
    torch.manual_seed(9113)
    base = Learner()
    source = out/"alpha09.pt"
    history["alpha09_initial"] = fit(base,past,dev,3,9113,source)
    history["alpha09"] = fit(base,past,dev,8,9113,source,resume=True)
    checkpoints = {"alpha09":base}
    rng = np.random.default_rng(49)
    replay = past.take(rng.choice(len(past),min(len(past),430),replace=False))
    for method in ("plain","replay","prioritized","distillation","partial","joint"):
        model = deepcopy(base)
        if method=="partial":
            model.encoder.requires_grad_(False)
        rows = Samples.join(past,future) if method=="joint" else future
        history[method] = fit(model,rows,dev,6,9114,out/(method+".pt"),strategy=method,
            replay=replay if method in ("replay","prioritized","distillation") else None,
            teacher=base if method=="distillation" else None)
        checkpoints[method] = model
    imitation = deepcopy(base)
    demonstrations = Samples.join(past,future)
    best_actions = demonstrations.values.masked_fill(~demonstrations.mask,-torch.inf).argmax(1)
    history["imitation"] = fit(imitation,demonstrations,dev,6,9114,out/"imitation.pt",strategy="imitation")
    history["imitation"]["label_counts"] = dict(zip(ACTIONS,torch.bincount(best_actions,minlength=len(ACTIONS)).tolist()))
    candidates = {}
    for name,model in checkpoints.items():
        cutoff = threshold_for(model,dev)
        candidates[name] = {"threshold":cutoff,
            "old":fixed_rows(model,old_dev,cutoff),"new":fixed_rows(model,new_dev,cutoff)}
    old_ref = candidates["alpha09"]["old"]
    def retains(row):
        old=row["old"]
        return (old["root_exact"]>=old_ref["root_exact"]*.98 and
                old["critical_misses"]<=old_ref["critical_misses"] and
                old["decision_exact"]>=old_ref["decision_exact"]*.97)
    def merit(row):
        new=row["new"]
        return new["root_exact"]+.35*new["decision_exact"]-3*new["critical_misses"]
    eligible = [name for name,row in candidates.items() if retains(row)]
    chosen = max(eligible,key=lambda name:merit(candidates[name]))
    history["adaptation"] = {"candidates":candidates,"retained":eligible,"chosen":chosen,
                             "rollback":chosen=="alpha09"}
    print("α-10 selected",chosen,flush=True)

    current = checkpoints[chosen]
    novel = generate(("camera-shift",), 930000, 6, stride=6)
    novel_dev = generate(("camera-shift",), 931000, 14)
    all_dev = Samples.join(dev,novel_dev)
    weaknesses_before, breakdown = weaknesses(current,all_dev,threshold_for(current,all_dev))
    history["curriculum"] = {"weights":weaknesses_before,"validation_groups":breakdown,
                            "new_experiences_available":len(novel)}
    # A fixed 64-example budget for the active and random policies. Priority is a
    # group-level estimate from development telemetry, with rehearsal below.
    budget = min(64,len(novel))
    weights = np.array([weaknesses_before[tag] for tag in novel.tags])
    uniform = rng.choice(len(novel),budget,replace=False)
    directed = rng.choice(len(novel),budget,replace=False,p=weights/weights.sum())
    history["curriculum"]["sampled"] = {"random":sizes(novel.take(uniform)),"active":sizes(novel.take(directed))}
    torch.manual_seed(9115)
    start = Learner(transfer=False)
    for mode,model,indices in (
        ("fewshot-scratch",start,uniform),("fewshot-transfer",deepcopy(current),uniform),
        ("fewshot-active",deepcopy(current),directed)):
        history[mode] = fit(model,novel.take(indices),all_dev,5,9115,out/(mode+".pt"),
                           replay=replay if mode!="fewshot-scratch" else None)
        checkpoints[mode] = model
    # Reptile: inner updates on different fault regimes, outer interpolation.
    meta = deepcopy(base)
    tasks = [past.take(np.flatnonzero(np.char.startswith(past.tags,"short:"))),future]
    timings = []
    for turn in range(8):
        task = tasks[turn%len(tasks)]
        sample = task.take(rng.choice(len(task),64,replace=False))
        inner = deepcopy(meta)
        timings.append(fit(inner,sample,dev,2,932000+turn)["seconds"])
        with torch.no_grad():
            for dest,src in zip(meta.parameters(),inner.parameters()):
                dest.lerp_(src,.25)
    torch.save({"weights":meta.state_dict()},out/"meta-initial.pt")
    history["meta_outer"] = {"rounds":len(timings),"seconds":sum(timings),
                             "inner_examples_per_round":64}
    history["fewshot-meta"] = fit(meta,novel.take(uniform),all_dev,5,9115,out/"fewshot-meta.pt")
    checkpoints["fewshot-meta"] = meta
    for mode in ("fewshot-scratch","fewshot-transfer","fewshot-active","fewshot-meta"):
        model = checkpoints[mode]
        cut = threshold_for(model,all_dev)
        candidates[mode] = {"threshold":cut,"old":fixed_rows(model,old_dev,cut),
                            "new":fixed_rows(model,novel_dev,cut)}
    novel_ref = fixed_rows(current,novel_dev,candidates[chosen]["threshold"])
    # Preserve old and intermediate domains when admitting a new candidate.
    mid_ref = fixed_rows(current,new_dev,candidates[chosen]["threshold"])
    finalist = [mode for mode in ("fewshot-transfer","fewshot-active","fewshot-meta")
        if retains(candidates[mode])
        and merit(candidates[mode]) > merit({"new":novel_ref})
        and candidates[mode]["new"]["critical_misses"] <= novel_ref["critical_misses"]
        and fixed_rows(checkpoints[mode],new_dev,candidates[mode]["threshold"])["root_exact"] >= mid_ref["root_exact"]*.98]
    winner = max(finalist,key=lambda n:merit(candidates[n])) if finalist else chosen
    history["curriculum"].update({"fewshot_eligible":finalist,"selected":winner,
                            "baseline_new":novel_ref,"rollback":not finalist})
    history["selection"] = {"alpha10":chosen,"alpha11":winner,"threshold":candidates[winner]["threshold"]}
    dump(out/"training.json",history)
    print("α-11 selected",winner,flush=True)


def evaluate(out):
    history = json.loads((out/"training.json").read_text())
    selected = history["selection"]["alpha11"]
    candidate_info = history["adaptation"]["candidates"]
    models = {name:reload(out/(name+".pt")) for name in candidate_info}
    planner = Planner()
    imitation = reload(out/"imitation.pt")
    used_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    source=out/"episodes.json"
    source.write_bytes(gzip.decompress((out/"episodes.json.gz").read_bytes()))
    archive=Archive.load(source)
    source.unlink()
    # Lock the policy margin using separate development rollouts.
    tuning = [(margin,closed_loop("hybrid",models[selected],"wireless",(940000,),8,margin))
              for margin in (.04,.10,.18)]
    margin,_ = max(tuning,key=lambda candidate: (
        candidate[1]["total"]["restored"],-candidate[1]["total"]["lost"],-candidate[1]["total"]["unnecessary"]))
    alpha08_margin = json.loads((Path(__file__).parents[1]/"causal/artifacts/value-results.json").read_text())["margin"]
    calibration = generate(PROFILES, 945000, 8)
    interval = effect_interval(models[selected],calibration)
    results = {"alpha08_margin":alpha08_margin,"effect_abs_error_p90":interval,"validation_policy":[{"margin":m,**row} for m,row in tuning], "margin":margin,
               "selection":history["selection"],"profiles":{}}
    final_seeds = (970000,980000,990000)
    for profile in PROFILES:
        batch = Samples.join(*(generate((profile,),start,9) for start in final_seeds))
        values = {name:fixed_rows(model,batch,candidate_info[name]["threshold"]) for name,model in models.items()}
        baseline = values["alpha09"]
        for row in values.values():
            row["retention_vs_alpha09"] = row["root_exact"]/max(1,baseline["root_exact"])
        model = models[selected]
        cutoff = candidate_info[selected]["threshold"]
        mem = archive_scores(model,batch,cutoff,Search(archive,VERSION[profile]))
        decision = {kind:closed_loop(kind,engine,profile,final_seeds,7,limit)
                    for kind,engine,limit in (("wait",None,0),("rules",None,0),("alpha08",planner,alpha08_margin),
                        ("hybrid",model,margin),("value",model,0),("imitation",imitation,0))}
        groups = for_groups(model,batch,cutoff)
        pre = history["curriculum"]["weights"]
        final_weights,_ = weaknesses(model,batch,cutoff)
        shared = list(final_weights)
        comparisons = [(a,b) for i,a in enumerate(shared) for b in shared[i+1:] if pre[a]!=pre[b]]
        self_evaluation = {"rank_pairs":len(comparisons),"direction_agrees":sum(
            (pre[a]-pre[b])*(final_weights[a]-final_weights[b])>0 for a,b in comparisons)}
        results["profiles"][profile] = {"samples":sizes(batch),"models":values,"memory":mem,
                               "policies":decision,"groups":groups,"self_evaluation":self_evaluation,
                               "forecast":forecast_rollout(model,profile,final_seeds),
                               "effect_calibration":effect_interval(model,batch,interval)}
        print(profile, {name:(row["total"]["restored"],row["total"]["incidents"],row["total"]["unnecessary"])
              for name,row in decision.items()},flush=True)
    results["rss_kib"] = {"before_final":used_rss,"peak":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    dump(out/"results.json",results)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",type=Path,default=Path(__file__).with_name("artifacts"))
    p.add_argument("--stage",choices=("train","eval","all"),default="all")
    a = p.parse_args()
    a.out.mkdir(parents=True,exist_ok=True)
    if a.stage in ("train","all"):
        learn(a.out)
    if a.stage in ("eval","all"):
        evaluate(a.out)
    files = (p for p in sorted(a.out.iterdir()) if p.is_file() and p.name!="SHA256SUMS")
    (a.out/"SHA256SUMS").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files))
