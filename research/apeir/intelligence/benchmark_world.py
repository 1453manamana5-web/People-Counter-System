"""A balanced, paired benchmark with recoverable and irrecoverable faults."""
from dataclasses import dataclass

import numpy as np

from day import Day, fork
from world import N, allowed

GROUPS = ("normal", "camera", "engine", "compound", "network", "storage", "missing", "conflict")
RECOVERABLE = ("camera", "engine", "compound", "missing", "conflict")
SEEDS = {
    "train": (1200000, 48),
    "router": (1250000, 16),
    "validation": (1300000, 18),
    "adaptation": (1400000, 8),
    "fixed": (1500000, 21),
    "fresh": (1600000, 21),
}
WINDOW = 8
PREDICTION_STEPS = (1, 3, 6)


@dataclass(frozen=True)
class Scenario:
    group: str
    seed: int
    shift: bool


def scenarios(split):
    start, count = SEEDS[split]
    # Modulo three groups are separately reproducible.
    return [Scenario(group, start + index*1000 + i, split in ("fresh","adaptation"))
            for index,group in enumerate(GROUPS) for i in range(count)]


class BenchmarkWorld(Day):
    horizon = 40

    def __init__(self, case):
        super().__init__(case.seed, "festival")
        self.case = case
        self.incidents.clear()
        self.horizon = 96 if case.shift else self.horizon
        # The tape is generated once and shared by all paired branches.
        rng = np.random.default_rng(case.seed+238)
        self.shocks = rng.random((self.horizon+1,2,26))
        side = case.seed % 2
        plans = {
            "normal": (), "camera": ((side,1),), "engine": ((side,2),),
            "compound": ((side,1),(side,2),(1-side,2)),
            "network": ((0,0),(1,0)), "storage": ((side,3),(1-side,1)),
            "missing": ((side,1),(1-side,2)), "conflict": ((side,2),(1-side,4)),
        }
        self.initial_roots = plans[case.group]
        self.released_at = None
        if case.shift and case.group in ("camera","engine","compound"):
            self.released_at = 3 + case.seed%5
        else:
            self.inject()
        self.initial_bad = bool(self.initial_roots)

    def inject(self):
        for side,root in self.initial_roots:
            self.state.roots[side,root] = True
            self.state.persistent[side,root] = True
        self.state.stable=0

    def restart_succeeds(self, side, root, shock):
        return shock[side,7] < (.72 if self.case.shift else .90)

    def observe(self, clean=False):
        signals = super().observe(clean)
        if clean:
            return signals
        noise = self.shocks[self.state.now]
        if self.case.group=="missing" or self.case.shift:
            for side in range(2):
                mask = noise[side,17:21] < (.30 if self.case.group=="missing" else .10)
                signals[10*side:10*side+4][mask] = -1
        if self.case.group=="conflict":
            # Contradiction affects only displayed load, never control permissions.
            for side in range(2):
                if noise[side,22]<.38:
                    signals[side*10+9]=1-signals[side*10+9] if signals[side*10+9]>=0 else -1
        return signals

    def step(self, action):
        # Preserve the inherited action guard and let the clock continue
        # for all policies, even when an operator referral is recorded.
        event = super().step(action)
        if self.state.now == self.released_at:
            self.inject()
            event["restored"]=False
        return event


def frames_start(world):
    return np.stack([world.observe()]*WINDOW)


def append(frames, obs):
    return np.concatenate((frames[1:],obs[None]))


def outcome(world):
    state=world.state
    return np.array([state.roots.sum(), state.lost.sum(), (state.queues+state.flight).sum()],np.float32)


def project(world, first, follow):
    """Only the simulator scorer reads latent faults and missed passages."""
    w=fork(world)
    samples=[]
    for index in range(max(PREDICTION_STEPS)):
        want=first if index==0 else follow if index==1 else 0
        action=want if allowed(w.observe())[want] else 0
        if not w.state.done:
            w.step(action)
        if index+1 in PREDICTION_STEPS:
            samples.append(np.r_[w.observe(clean=True),outcome(w)])
    return np.asarray(samples,np.float32)


def label_world(world, obs):
    mask=allowed(obs)
    mask[1:3]=False  # Diagnostics and referrals cannot change paired physical outcomes.
    base=project(world,0,0)
    gains=np.zeros((N,N,len(PREDICTION_STEPS)),np.float32)
    present=np.zeros((N,N),bool)
    immediate=outcome(world)
    for first in np.flatnonzero(mask):
        trial=fork(world)
        trial.step(int(first))
        next_mask=allowed(trial.observe())
        options=[0,*(np.flatnonzero(next_mask[3:])+3).tolist()] if not trial.state.done else [0]
        for follow in options:
            if first!=0 and first==follow and first>=5:
                continue
            result=project(world,int(first),int(follow))
            # Exact same exogenous tape for the action and wait branches.
            causal=(base[:,-3:] - result[:,-3:]) @ np.array([.48,.55,.09],np.float32)
            gains[first,follow]=causal
            present[first,follow]=True
    return world.state.roots.flatten().copy(),base[:,:-3],gains,present,immediate


def sample(split):
    rng=np.random.default_rng(SEEDS[split][0])
    for case in scenarios(split):
        world=BenchmarkWorld(case)
        frames=frames_start(world)
        for _ in range(min(world.horizon,24)):
            obs=frames[-1]
            if world.state.now in (0,1,3,5,8,12,17,22):
                yield case,frames.copy(),label_world(world,obs)
            action=0
            if world.state.now>1 and rng.random()<.56:
                legal=np.flatnonzero(allowed(obs)[3:])+3
                if len(legal):
                    action=int(rng.choice(legal))
            world.step(action)
            frames=append(frames,world.observe())
