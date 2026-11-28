"""Shared metrics for fixed observations, weighted curricula and closed loops."""
from time import perf_counter_ns

import numpy as np
import torch

from day import fork, make_world, paired_targets
from planning import strong_rules
from train import HISTORY, load
from world import ROOT_COUNT, WIDTH, allowed


def predict(model, rows):
    with torch.inference_mode():
        cause, future, value, effect = model(rows.histories)
    return cause.sigmoid().numpy(), future.sigmoid().numpy(), value.numpy(), effect.numpy()


def diagnose(probs, truth, threshold):
    guesses = probs >= threshold
    actual = np.asarray(truth, bool)
    normal = ~actual.any(1)
    alarm = guesses.any(1)
    compound = actual.sum(1)>1
    severe = compound | actual[:,[3,8]].any(1)
    wrong = (guesses != actual).any(1)
    confidence = np.abs(probs-.5).mean(1)*2
    certain = confidence >= .7
    return {"cases": len(actual), "root_exact": int((~wrong).sum()),
        "critical_misses": int((~normal & ~alarm).sum()), "abnormal": int((~normal).sum()),
        "normal": int(normal.sum()), "false_alarms": int((normal & alarm).sum()),
        "compound_cases":int(compound.sum()),"compound_exact":int((compound & ~wrong).sum()),
        "severe_cases":int(severe.sum()),"severe_misses":int((severe & ~alarm).sum()),
        "brier": float(((probs-actual)**2).mean()), "confident_cases": int(certain.sum()),
        "confident_errors": int((certain & wrong).sum())}


def threshold_for(model, rows):
    p, *_ = predict(model, rows)
    def score(limit):
        stats = diagnose(p, rows.roots.numpy(), limit)
        return stats["root_exact"] - 3*stats["critical_misses"] - .5*stats["false_alarms"]
    return max((.25,.35,.45,.50,.55,.65), key=score)


def fixed_rows(model, rows, cutoff):
    p, y, values, effects = predict(model, rows)
    mask = rows.mask.numpy()
    active = mask.copy()
    active[:,:3] = False
    targets = rows.values.numpy()
    selected = np.where(mask, values, -np.inf).argmax(1)
    agreement = targets[np.arange(len(rows)),selected] >= np.where(mask,targets,-np.inf).max(1)-.03
    steps = {"decision_exact": int(agreement.sum()),
             "state_mae": float(np.abs(y-rows.base.numpy()).mean()),
             "persistence_mae": float(np.abs(np.c_[rows.histories.numpy()[:,-1].clip(0,1),
                 np.zeros(len(rows))]-rows.base.numpy()).mean()),
             "effect_count":int(active.sum()),
             "effect_mae":float(np.abs(effects[active]-rows.effects.numpy()[active]).mean()) if active.any() else None,
             "zero_effect_mae":float(np.abs(rows.effects.numpy()[active]).mean()) if active.any() else None}
    return {**diagnose(p, rows.roots.numpy(), cutoff), **steps}


def for_groups(model, rows, cutoff):
    return {str(tag): fixed_rows(model, rows.take(np.flatnonzero(rows.tags==tag)), cutoff)
            for tag in np.unique(rows.tags)}


def weaknesses(model, rows, cutoff):
    groups = for_groups(model, rows, cutoff)
    def weight(row):
        cases = row["cases"]
        return (.15 + (cases-row["decision_exact"])/cases
                + (cases-row["root_exact"])/cases + 3*row["critical_misses"]/cases
                + .30*min(1., row["effect_mae"] or 0.))
    return {tag: weight(row) for tag,row in groups.items()}, groups


def archive_scores(model, rows, cutoff, index):
    baseline = load("cause-gru")
    with torch.inference_mode():
        initial = baseline(rows.histories).sigmoid().numpy()
    learned, *_ = predict(model, rows)
    variants = {"old": initial, "learned": learned, "memory_only": initial.copy(),
                "routed_old_memory": initial.copy(), "routed_learned_memory": learned.copy()}
    started = []
    coverage = exact = useful = untrusted = 0
    for i, history in enumerate(rows.histories.numpy()):
        tick = perf_counter_ns()
        related,distance = index.find(history)
        started.append((perf_counter_ns()-tick)/1e6)
        untrusted += distance > .20
        if related:
            closest = np.asarray(related[0].roots)
            exact += int(np.array_equal(closest, rows.roots[i].numpy()))
            useful += int((closest & rows.roots[i].numpy()).any())
            coverage += 1
            average = np.mean([r.roots for r in related], axis=0)
            variants["memory_only"][i] = average
            if distance <= .20:
                if ((initial[i] >= .25)&(initial[i] <= .60)).any():
                    variants["routed_old_memory"][i] = .7*initial[i]+.3*average
                if ((learned[i] >= .25)&(learned[i] <= .60)).any():
                    variants["routed_learned_memory"][i] = .7*learned[i]+.3*average
    return {"top_one_exact": exact,"top_one_positive_overlap": useful,"retrieved": coverage,
            "outside_retrieval_radius":int(untrusted),
            "search_p95_ms":float(np.quantile(started,.95)),
            "diagnosis": {key:diagnose(value, rows.roots.numpy(), .5 if key.startswith("old")
                or key in ("routed_old_memory","memory_only") else cutoff) for key,value in variants.items()}}


def policy_action(kind, agent, history, margin, cooldown):
    obs = history[-1]
    rule = strong_rules(obs)
    if kind == "wait":
        return 0, False
    if kind == "rules":
        return rule, False
    if kind == "alpha08":
        return agent.action_value(history, margin)
    legal = allowed(obs)
    eligible = np.flatnonzero(legal[3:])+3
    if kind == "hybrid" and not len(eligible):
        return (1 if rule==2 and cooldown else rule), False
    with torch.inference_mode():
        _,_,value,effect = agent(torch.as_tensor(history[None]))
    estimates = value[0].numpy().copy()
    if kind in ("value","imitation"):
        return int(np.where(legal,estimates,-np.inf).argmax()), True
    # Root-time observation can distinguish a plausible engine fault from transient load.
    for candidate in eligible:
        if candidate >= 7 and obs[((candidate-7)%2)*10+9] == 1:
            estimates[candidate] -= .12
    candidate = int(eligible[estimates[eligible].argmax()])
    if rule not in eligible or candidate == rule or (
            estimates[candidate]>=estimates[rule]+margin and effect[0,candidate]>=effect[0,rule]-.1):
        if rule in eligible and estimates[rule]<-.12 and estimates[candidate]<-.12:
            return 1, True
        return candidate, True
    return rule, True


def closed_loop(kind, model, profile, starts, count, margin):
    totals = {}
    elapsed = []
    for start in starts:
        result = dict(episodes=0, incidents=0, restored=0, compound_incidents=0, compound_restored=0,
                      multistep_recoveries=0, blocked=0, unnecessary=0, human=0, operations=0,
                      decisions=0, exact=0, routed=0, lost=0, normal_operations=0, ticks_until_restore=0)
        for seed in range(start,start+count):
            w = make_world(seed,profile)
            frames = np.stack([w.observe()]*HISTORY)
            result["episodes"] += 1
            pending = w.initial_bad
            compound = w.state.roots.sum()>=2
            began = 0
            last_referral = -100
            moves = 0
            while not w.state.done:
                if profile!="short" and w.state.roots.any() and not pending:
                    pending = True
                    began = w.state.now
                    moves = 0
                    compound = False
                compound |= pending and w.state.roots.sum()>=2
                tick = perf_counter_ns()
                action,routed = policy_action(kind,model,frames,margin,w.state.now-last_referral<6)
                elapsed.append((perf_counter_ns()-tick)/1e6)
                mask,values,_,_ = paired_targets(w,frames[-1])
                result["exact"] += int(values[action]>=values[mask].max()-.03)
                result["normal_operations"] += int(action>=3 and not w.state.roots.any() and action>=5)
                if action==2:
                    last_referral = w.state.now
                event = w.step(action)
                result["decisions"] += 1
                result["routed"] += int(routed)
                result["blocked"] += int(event["blocked"])
                result["human"] += int(event["action"]==2)
                result["unnecessary"] += int(event["unnecessary"])
                result["operations"] += int(event["action"]>=3)
                moves += int(event["action"]>=3)
                if pending and (event["restored"] or w.state.done):
                    result["incidents"] += 1
                    result["compound_incidents"] += int(compound)
                    result["restored"] += int(event["restored"])
                    if event["restored"]:
                        result["ticks_until_restore"] += w.state.now-began
                    result["compound_restored"] += int(compound and event["restored"])
                    result["multistep_recoveries"] += int(event["restored"] and moves>1)
                    pending = False
                frames = np.concatenate((frames[1:],w.observe()[None]))
            result["lost"] += int(w.state.lost.sum())
        totals[str(start)] = result
    return {"seed_groups":totals,"p95_ms":float(np.quantile(elapsed,.95)),
            "total":{key:sum(row[key] for row in totals.values()) for key in next(iter(totals.values()))}}



def effect_interval(model, rows, radius=None):
    _,_,_,effects = predict(model,rows)
    mask = rows.mask.numpy().copy()
    mask[:,:3] = False
    residuals = np.abs(effects[mask]-rows.effects.numpy()[mask])
    if radius is None:
        return float(np.quantile(residuals,.9,method="higher"))
    return {"cases":int(mask.sum()),"covered":int((residuals<=radius).sum())}


@torch.inference_mode()
def forecast_rollout(model, profile, starts):
    old = load("world-gru")
    errors = {step: {"trained": [],"alpha08": [],"persist": []} for step in (1,3,6)}
    for group in starts:
        for seed in range(group,group+6):
            world = make_world(seed,profile)
            obs = world.observe()
            history = np.stack([obs]*HISTORY)
            while not world.state.done:
                if world.state.now%7==seed%7:
                    frozen = obs.clip(0,1)
                    new_x,old_x = history.copy(),history.copy()
                    held = [5,6,7,8,15,16,17,18]
                    branch = fork(world)
                    for step in range(1,7):
                        if branch.state.done:
                            break
                        estimate = model(torch.from_numpy(new_x[None]))[1].sigmoid().numpy()[0,:WIDTH]
                        previous = old(torch.from_numpy(old_x[None]),torch.tensor([0])).sigmoid().numpy()[0,:WIDTH]
                        branch.step(0)
                        truth = branch.observe(clean=True)
                        if step in errors:
                            for name,values in (("trained",estimate),("alpha08",previous),("persist",frozen)):
                                errors[step][name].append(float(np.abs(values-truth).mean()))
                        estimate[held] = previous[held] = obs[held]
                        new_x = np.concatenate((new_x[1:],estimate[None]))
                        old_x = np.concatenate((old_x[1:],previous[None]))
                world.step(0)
                obs = world.observe()
                history = np.concatenate((history[1:],obs[None]))
    return {str(step):{"cases":len(row["trained"]),
                       "mae":{key:float(np.mean(vals)) if vals else None for key,vals in row.items()}}
            for step,row in errors.items()}
