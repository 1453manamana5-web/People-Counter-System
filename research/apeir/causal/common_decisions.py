"""Compare judgment on identical observations, independent of policy rollouts."""
import json
import numpy as np

from evaluate import fixed_episodes
from legacy import Legacy
from planning import Planner,strong_rules
from train import HISTORY, OUT, action_scores
from world import World,allowed


def main():
    planner=Planner()
    models={name:Legacy(name) for name in ("alpha03","alpha04-dqn","alpha05")}
    result={}
    margin=json.loads((OUT/"value-results.json").read_text())["margin"]
    for profile,_,seed in fixed_episodes():
        metrics=result.setdefault(profile,{"decisions":0,"correct":{name:0 for name in
            ("rules","beam","guarded-value",*models)}})
        world=World(seed,profile)
        histories=[world.observe()]*HISTORY
        memory={key:model.memories() for key,model in models.items()}
        while not world.state.done:
            history=np.stack(histories[-HISTORY:])
            scores=action_scores(world,history[-1])
            mask=allowed(history[-1])
            actions={"rules":strong_rules(history[-1]),"beam":planner.best(history)[0],
                     "guarded-value":planner.action_value(history,margin)[0]}
            actions.update({name:model.act(history,memory[name])[0] for name,model in models.items()})
            for name,action in actions.items():
                metrics["correct"][name]+=int(mask[action] and scores[action]>=scores.max()-.03)
            metrics["decisions"]+=1
            # Common observation data come from a fixed baseline behavior.
            world.step(actions["rules"])
            histories.append(world.observe())
    (OUT/"common-decisions.json").write_text(json.dumps(result,indent=2)+"\n")


if __name__=="__main__":
    main()
