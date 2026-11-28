"""Synthetic full-day profiles using the α-08 station and safety physics."""
from copy import copy, deepcopy

import numpy as np

from world import N, World, allowed, rules

PROFILES = ("short", "festival", "wireless", "camera-shift")
VERSION = {"short": "alpha08", "festival": "day-v1", "wireless": "day-v1", "camera-shift": "day-v2"}


class Day(World):
    horizon = 96

    def __init__(self, seed, profile):
        super().__init__(seed, "school" if profile == "wireless" else "standard")
        self.schedule = profile
        self.state.roots[:] = False
        self.state.persistent[:] = False
        self.state.queues[:] = 0
        self.initial_bad = False
        rng = np.random.default_rng(seed ^ 327681)
        self.incidents = []
        for base_time in (9, 33, 61):
            when = base_time + int(rng.integers(0, 10))
            side = int(rng.integers(0, 2))
            if profile == "wireless":
                faults = [(0, 0, 13), (1, 0, 15), (side, 3, 6)]
            elif profile == "camera-shift":
                faults = [(side, 4, 12), (side, 1, 7), (1-side, 2, 5)]
            else:
                faults = [(side, int(rng.integers(1, 5)), 5), (1-side, 0, 7)]
            for delay, (station, root, duration) in enumerate(faults[:rng.integers(1, len(faults)+1)]):
                # Some camera/engine incidents can be cleared by a permitted action.
                self.incidents.append((when+delay*2, when+delay*2+duration, station, root))

    def arrivals(self, side, shock):
        now = self.state.now
        phase = .15 if now < 10 or now >= 86 else .75 if 25 <= now < 66 else .40
        return int(shock[side, 14] < (phase if side == 0 else phase*.82))

    def ended(self):
        return self.state.now >= self.horizon

    def step(self, action):
        # Referrals are logged in the full-day scenario. Local counting continues.
        referral = type(action) in (int,np.int64,np.int32) and action == 2
        event = super().step(0 if referral else action)
        if referral:
            event["action"] = 2
        now = self.state.now
        for start, end, side, root in self.incidents:
            if now == start:
                self.state.roots[side, root] = True
                self.state.persistent[side, root] = root in (0, 3, 4)
                self.state.stable = 0
            if now == end:
                self.state.persistent[side, root] = False
                self.state.roots[side, root] = False
        if now and now % 8 == 0:
            # Replenish temporary trial budget only after a cooldown.
            self.state.credit[:] = 1
        event["restored"] = self.state.stable == 2 and not self.bad()
        return event


def make_world(seed, profile, normal=False):
    world = World(seed) if profile == "short" else Day(seed, profile)
    if normal:
        world.state.roots[:] = False
        world.state.persistent[:] = False
        world.state.queues[:] = 0
        world.initial_bad = False
        if isinstance(world, Day):
            world.incidents.clear()
    return world


def fork(world):
    branch = copy(world)
    branch.state = deepcopy(world.state)
    return branch


def paired_targets(world, obs):
    """Privilege is confined to the simulator's counterfactual labels."""
    mask = allowed(obs)
    values = np.zeros(N, dtype=np.float32)
    immediate = np.zeros(N, dtype=np.float32)
    base_after = None
    for action in np.flatnonzero(mask):
        branch = fork(world)
        value = 0.
        for depth in range(3):
            chosen = int(action) if depth == 0 else rules(branch.observe())
            event = branch.step(chosen)
            state = branch.state
            step_cost = (.30*state.roots.sum() + .075*(state.queues+state.flight).sum()
                         + .32*(state.lost-world.state.lost).sum())
            if depth == 0:
                immediate[action] = -step_cost
                if action == 0:
                    base_after = np.r_[branch.observe(clean=True), float(branch.bad())]
            value -= (.9**depth)*step_cost + .5*int(event["unnecessary"])
            if state.done:
                break
        values[action] = value + .5*(state.stable==2) - .08*(action>=3) - .02*(action==1) - 1.8*(action==2)
    immediate[mask] -= immediate[0].copy()
    values[mask] -= values[0].copy()
    return mask, values, immediate, base_after.astype(np.float32)
