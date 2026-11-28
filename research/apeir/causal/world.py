"""Two simulated stations. All observations and transitions are synthetic."""
from dataclasses import dataclass
import numpy as np

ROOTS = ("network", "camera", "engine", "storage", "load")
ROOT_COUNT = len(ROOTS)
ACTIONS = ("wait", "probe", "refer", "sync-in", "sync-out",
           "camera-in", "camera-out", "engine-in", "engine-out")
N = len(ACTIONS)
WIDTH = 23
HORIZON = 16
# Explicit causal edges. Load degrades recognition despite a healthy camera.
EDGES = {"network": ("link", "heartbeat", "queue", "delivery"),
         "camera": ("camera", "recognition", "lost"),
         "engine": ("recognition", "lost"), "storage": ("storage", "queue", "lost"),
         "load": ("recognition", "lost"), "queue": ("delivery",),
         "delivery": ("server_count",), "server_count": ("management",)}


def allowed(obs):
    mask=np.zeros(N,dtype=bool)
    mask[:3]=True
    for side in range(2):
        link, camera, engine, storage, queue, tracking, visible, authorized, credit = obs[side*10:side*10+9]
        mask[3+side]=link==1 and storage==1 and queue>0
        safe=tracking==0 and visible==authorized==credit==1 and storage==1
        mask[5+side]=safe and camera==0
        mask[7+side]=safe and camera==1 and engine==0
    return mask


@dataclass
class State:
    roots: np.ndarray
    persistent: np.ndarray
    queues: np.ndarray
    flight: np.ndarray
    counts: np.ndarray
    credit: np.ndarray
    tracking: np.ndarray
    authorized: np.ndarray
    visible: np.ndarray
    lost: np.ndarray
    stable: int=0
    now: int=0
    done: bool=False


class World:
    horizon = HORIZON

    def __init__(self, seed, profile="standard"):
        self.profile=profile
        rng=np.random.default_rng(seed)
        probability=np.array([.25,.19,.17,.13,.22])
        roots=rng.random((2,ROOT_COUNT))<probability
        if profile=="school" and rng.random()<.6:
            roots[:,0]=True
        if profile=="busy" and rng.random()<.65:
            roots[:,4]=True
            roots[1,2]=True
        self.state=State(roots, rng.random(roots.shape)<(.30 if profile=="busy" else .12),
                         rng.integers(0,4,2),np.zeros(2,int),np.zeros(2,int),np.ones(2,int),
                         np.zeros(2,int),rng.random(2)>.08,rng.random(2)>.08,np.zeros(2,int))
        self.initial_bad=self.bad()
        # Shared shocks are indexed by time so paired counterfactuals get the same shocks.
        self.shocks=rng.random((self.horizon+1,2,26))

    def bad(self):
        s=self.state
        return bool(s.roots.any() or s.queues.any() or s.flight.any())

    def observe(self, clean=False):
        s=self.state
        blocks=[]
        shock=self.shocks[min(s.now,self.horizon)]
        for side, row in enumerate(s.roots):
            net,cam,eng,disk,load=row
            block=np.array([not net,not cam,not(eng or cam or load),not disk,
                            min(12,s.queues[side])/12,s.tracking[side],s.visible[side],
                            s.authorized[side],s.credit[side],load],np.float32)
            missing=.20 if self.profile=="school" else .12
            if not clean:
                block[:5][shock[side,:5]<missing]=-1
                if net:
                    block[1:4]=-1
                if shock[side,5]<missing:
                    block[9]=-1
            blocks.extend(block)
        # Last three signals are management receipts and verification status.
        reception=np.minimum(s.counts,32)/32
        if not clean and shock[0,6]<.15:
            reception=np.full(2,-1)
        return np.array([*blocks,*reception,s.stable/2],np.float32)

    def intervention(self, side, root):
        """Controlled do(root=0), isolated from operator actions."""
        self.state.roots[side,root]=False

    def arrivals(self, side, shock):
        return int(shock[side,14]<(.70 if self.profile=="busy" else .40))

    def ended(self):
        return self.state.stable==2 or self.state.now>=self.horizon

    def restart_succeeds(self, side, root, shock):
        return not self.state.persistent[side,root] and shock[side,7]<.85

    def step(self, action):
        s=self.state
        if s.done:
            raise ValueError("Episode ended")
        if type(action) not in (int,np.int64,np.int32) or not 0<=action<N:
            raise ValueError("Unknown action")
        blocked=not allowed(self.observe())[action]
        if blocked:
            action=1
        unnecessary=False
        shock=self.shocks[s.now]
        before=s.roots.copy()
        if action==2:
            s.done=True
            return {"action":action,"blocked":blocked,"unnecessary":False,"restored":False}
        if action>=3:
            side=(action-3)%2
            if action<=4:
                unnecessary=s.queues[side]==0
                moved=min(s.queues[side],3)
                s.queues[side]-=moved
                s.flight[side]+=moved
            else:
                root=1 if action<=6 else 2
                unnecessary=not s.roots[side,root]
                s.credit[side]=0
                if self.restart_succeeds(side,root,shock):
                    s.roots[side,root]=False
        for side in range(2):
            # Idempotent delivery at management; repeated receipts add zero.
            if not s.roots[side,0] and shock[side,8]>.13:
                s.counts[side]+=s.flight[side]
                s.flight[side]=0
            s.roots[side] &= s.persistent[side] | (shock[side,9:14]>=np.array([.23,.025,.05,.035,.25]))
            net,cam,eng,disk,load=s.roots[side]
            arrives=self.arrivals(side,shock)
            misses=arrives and (cam or eng or disk or (load and shock[side,15]<.65))
            s.lost[side]+=int(misses)
            s.tracking[side]=int(arrives and not (cam or eng))
            s.queues[side]+=int(arrives and not misses)
            if not net and not disk and s.queues[side] and shock[side,16]>.32:
                s.queues[side]-=1
                s.flight[side]+=1
        # Keep recent confirmation separate from today's provisional receipts.
        s.stable=min(2,s.stable+1) if not self.bad() else 0
        s.now+=1
        s.done=self.ended()
        return {"action":action,"blocked":blocked,"unnecessary":bool(unnecessary),
                "restored":s.stable==2,"cleared":int((before&~s.roots).sum())}



def rules(obs):
    ok=allowed(obs)
    # Try storage-safe flushing before a permitted camera/engine restart.
    for action in (3,4,5,6,7,8):
        if ok[action]:
            return action
    return 0
