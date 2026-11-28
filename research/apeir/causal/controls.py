"""A separate clean-start control with the same noisy telemetry."""
import json
import numpy as np

from evaluate import diag
from planning import Planner,strong_rules
from train import HISTORY,OUT,load
from world import ROOT_COUNT,World


def main():
    planner=Planner()
    classifier=load("cause-gru")
    result={}
    for profile in ("standard","school","busy"):
        counts={"cases":0,"cause_gru_flags":0,"rules_act":0,"beam_act":0}
        for seed in range(1_310_000,1_310_036):
            world=World(seed,profile)
            world.state.roots[:]=False
            world.state.queues[:]=0
            history=np.stack([world.observe()]*HISTORY)
            assert world.state.roots.shape==(2,ROOT_COUNT)
            counts["cases"]+=1
            counts["cause_gru_flags"]+=int(np.any(diag(classifier,history)>=.5))
            counts["rules_act"]+=int(strong_rules(history[-1])>=3)
            counts["beam_act"]+=int(planner.best(history)[0]>=3)
        result[profile]=counts
    (OUT/"normal-controls.json").write_text(json.dumps(result,indent=2)+"\n")


if __name__=="__main__":
    main()
