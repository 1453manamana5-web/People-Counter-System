"""A transparent observation/label adapter for the frozen single-station models."""
from pathlib import Path
import importlib
import sys

import numpy as np

from world import allowed

MODEL_ROOT=Path(__file__).resolve().parents[1]/"evolution"
current_world=sys.modules.pop("world")
sys.path.insert(0,str(MODEL_ROOT))
try:
    previous=importlib.import_module("integrated")
    supervised=importlib.import_module("supervised")
    reinforcement=importlib.import_module("reinforcement")
finally:
    sys.path.pop(0)
    sys.modules["world"]=current_world


class Legacy:
    def __init__(self,version):
        self.version=version
        path=MODEL_ROOT/"artifacts"
        if version=="alpha05":
            self.model=previous.Cascade(path)
        elif version=="alpha04-dqn":
            self.model=reinforcement.DQN.load(path/"dqn-latest.zip",device="cpu")
        else:
            self.model=supervised.load(path/"gru.pt")

    def act(self, history, memory):
        obs=history[-1]
        options=[]
        guesses=[]
        for side in range(2):
            block=history[:,10*side:10*side+10]
            seq=np.column_stack((block[:,:5],np.where(block[:,4]<0,-1,block[:,4]>0),
                                 block[:,5:9],history[:,22]))
            seq=np.concatenate((seq[:1],seq)).astype(np.float32)
            if self.version=="alpha05":
                action,diag,problem,_,p=self.model.decide(seq,memory[side])
            elif self.version=="alpha04-dqn":
                action=reinforcement.rl_action(self.model,seq)
                _,diag,problem=previous.rules(seq)
                p=float(problem)
            else:
                action,diag,problem,_,_,p=supervised.decision(self.model,seq)
            remap={0:0,1:3+side,2:5+side,3:7+side,4:2}
            candidate=remap[action]
            if allowed(obs)[candidate]:
                options.append((candidate,p))
            guesses.extend([*diag,False])
        if not options:
            return 1,np.asarray(guesses,bool)
        # An escalation from either station does not override a safe queued action.
        return max(options,key=lambda item:(int(item[0]>=3),int(item[0]!=2),item[1]))[0],np.asarray(guesses,bool)

    @staticmethod
    def memories():
        return [previous.EpisodeMemory(),previous.EpisodeMemory()]
