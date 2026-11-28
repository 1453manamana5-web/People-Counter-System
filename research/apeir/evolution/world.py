"""Isolated Gymnasium model of one station. No device, network or app access."""
from collections import deque
from enum import IntEnum

import gymnasium as gym
import numpy as np
from gymnasium import spaces


class Action(IntEnum):
    WAIT = 0
    SYNC = 1
    CAMERA = 2
    ENGINE = 3
    ASK = 4


HISTORY = 4
SIGNALS = ("heartbeat", "camera", "engine", "storage", "link", "pending",
           "tracking", "visible", "authorized", "budget", "stable")
N_FAULTS = 4  # communication, camera, inference, storage
SHAPE = (HISTORY, len(SIGNALS))
NORMAL = np.array([1, 1, 1, 1, 1, 0], dtype=np.float32)
TRAIN_START = 10_000
VALID_START = 200_000
TEST_START = 900_000


def permitted(history):
    """Independent conservative gate using observed, explicit authorization."""
    hb, cam, eng, _storage, link, pending, tracks, visible, authorized, budget, _stable = history[-1]
    return np.array([True, hb == link == 1 and pending == 1,
                     hb == visible == authorized == budget == 1 and tracks == 0 and cam == 0,
                     hb == visible == authorized == budget == 1 and tracks == 0 and cam == 1 and eng == 0,
                     True])


def guarded(history, proposal):
    return int(proposal) if permitted(history)[int(proposal)] else int(Action.ASK)


class ApeirWorld(gym.Env):
    metadata = {"render_modes": []}
    observation_space = spaces.Box(-1, 1, SHAPE, dtype=np.float32)
    action_space = spaces.Discrete(len(Action))

    def __init__(self, level=2, distribution="train"):
        self.level = level
        self.distribution = distribution

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.sensor = np.random.default_rng(int(self.np_random.integers(2**31)))
        self.step_no = self.verified = self.attempts = self.lost = 0
        self.tracking = 0
        self.visible = bool(self.np_random.random() > .10)
        self.authorized = bool(self.np_random.random() > .10)
        self.faults = np.zeros(N_FAULTS, dtype=bool)
        self.durable = int(self.np_random.integers(0, 4)) if self.np_random.random()<.20 else 0
        count = (self.np_random.choice([0, 1, 2, 3], p=[.29, .52, .15, .04]) if self.level>=2
                 else self.np_random.integers(0, 2))
        self.faults[self.np_random.choice(N_FAULTS, size=count, replace=False)] = True
        # Independent evaluation includes correlated faults and persistent failures.
        if self.distribution == "novel" and self.np_random.random()<.45:
            self.faults[[0, 2]] = True
        self.persistent = self.faults & (self.np_random.random(N_FAULTS) < (.25 if self.distribution=="novel" else .08))
        self.initial_problem = bool(self.faults.any() or self.durable)
        self._stale = NORMAL.copy()
        self.frames = deque([np.full(len(SIGNALS), -1, dtype=np.float32) for _ in range(HISTORY)], maxlen=HISTORY)
        self._observe()
        return self.observation(), {}

    def _observe(self):
        net, camera, engine, storage = self.faults
        status = np.array([not net, not camera, not engine, not storage,
                           not net, self.durable>0], dtype=np.float32)
        if self.level and net and self.sensor.random()<.65:
            status[1:] = self._stale[1:]
            status[0] = 0
        elif not net:
            self._stale = status.copy()
        missing = .03 if not self.level else (.23 if self.distribution=="novel" else .12)
        status[self.sensor.random(6)<missing] = -1
        if self.sensor.random() < missing / 2:
            status[0] = 0
        # The control fields describe the current authorization boundary.
        last = self.frames[-1] if self.frames else None
        verified_observation = last is not None and np.all(last[:4]==1) and np.all(status[:4]==1)
        control = [self.tracking, self.visible, self.authorized, self.attempts==0, verified_observation]
        self.frames.append(np.concatenate((status, control)).astype(np.float32))

    def observation(self):
        return np.stack(self.frames)

    def teacher(self):
        """Privileged reference, for offline labels/scoring only."""
        allow = permitted(self.observation())
        net, camera, engine, storage = self.faults
        if (camera or engine) and self.tracking:
            return int(Action.WAIT)
        if storage or (net and self.persistent[0] and self.step_no>=4):
            return int(Action.ASK)
        for index, action in ((1, Action.CAMERA), (2, Action.ENGINE)):
            if self.faults[index] and allow[action]:
                return int(action)
        if self.attempts and (camera or engine):
            return int(Action.ASK)
        if self.step_no>=7 and self.faults.any():
            return int(Action.ASK)
        if not net and self.durable and allow[Action.SYNC]:
            return int(Action.SYNC)
        return int(Action.WAIT)

    def step(self, action):
        action = Action(action)
        before = self.observation()
        proposed = action
        action = Action(guarded(before, action))
        blocked = proposed != action
        truth = self.teacher()
        faults = self.faults.copy()
        problem = bool(faults.any() or self.durable)
        unnecessary = (action==Action.CAMERA and not faults[1] or action==Action.ENGINE and not faults[2] or
                       action==Action.SYNC and (not self.durable or faults[0]))
        reward = -.14 - .24*int(faults.sum()) - min(self.durable, 8)*.025
        reward -= 1.8*unnecessary + 2.5*blocked
        self.step_no += 1
        if action == Action.ASK:
            # Escalation leaves the fault unresolved, even if it was prudent.
            reward += -.8 if truth==Action.ASK else -2.5
            return self.observation(), reward, True, False, self._result(
                truth, faults, problem, action, unnecessary, blocked, False)
        if action in (Action.CAMERA, Action.ENGINE):
            self.attempts += 1
            index = 1 if action==Action.CAMERA else 2
            if not self.persistent[index] and self.np_random.random()<.91:
                self.faults[index] = False
            reward -= .22
        elif action==Action.SYNC and not self.faults[0]:
            self.durable = max(0, self.durable-4)
            reward -= .06
        for i, rate in ((0,.26), (1,.05), (2,.08), (3,.05)):
            if self.faults[i] and not self.persistent[i] and self.np_random.random()<rate:
                self.faults[i] = False
        arrivals = self.np_random.binomial(3,.35)
        self.tracking = int(arrivals>0 and not self.faults[1] and not self.faults[2])
        if self.faults[1:].any():
            self.lost += arrivals
            reward -= arrivals*.18
        elif self.faults[0]:
            self.durable = min(16, self.durable+arrivals)
        elif self.durable:
            self.durable -= 1  # ordinary background synchronization
        healthy = not self.faults.any() and self.durable==0
        self.verified = self.verified+1 if healthy else 0
        done = self.verified>=2
        if done:
            reward += 5 if self.initial_problem else 2
        self._observe()
        return self.observation(), float(reward), done, self.step_no>=14 and not done, self._result(
            truth,faults,problem,action,unnecessary,blocked,done)

    @staticmethod
    def _result(teacher, faults, problem, action, unnecessary, blocked, recovered):
        return {"reference":teacher,"faults":faults,"problem":problem,"action":int(action),
                "unnecessary":bool(unnecessary),"blocked":bool(blocked),"recovered":bool(recovered)}


def rules(history):
    """Temporal baseline: infer candidates from currently observable evidence."""
    hb, cam, eng, storage, link, pending, tracking, *_ = history[-1]
    mask = permitted(history)
    fault = np.array([hb==0 or link==0, cam==0, eng==0, storage==0], dtype=bool)
    if storage==0:
        action = Action.ASK
    elif mask[Action.CAMERA]:
        action = Action.CAMERA
    elif mask[Action.ENGINE]:
        action = Action.ENGINE
    elif mask[Action.SYNC]:
        action = Action.SYNC
    elif (cam==0 or eng==0) and not tracking and (history[-3:,1:3]==0).sum()>=3:
        action = Action.ASK
    else:
        action = Action.WAIT
    return int(action), fault, bool(fault.any() or pending==1)
