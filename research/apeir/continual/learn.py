"""Masked, multi-task semantic memory and checkpointed continual learning."""
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from day import VERSION, make_world, paired_targets
from memory import Episode
from planning import strong_rules
from train import HISTORY, load
from world import N, ROOT_COUNT, WIDTH, allowed


@dataclass
class Samples:
    histories: torch.Tensor
    roots: torch.Tensor
    base: torch.Tensor
    mask: torch.Tensor
    values: torch.Tensor
    effects: torch.Tensor
    tags: np.ndarray

    def __len__(self):
        return len(self.tags)

    def take(self, indices):
        return Samples(*(value[indices] for value in vars(self).values()))

    @classmethod
    def join(cls, *items):
        columns = zip(*(vars(item).values() for item in items))
        return cls(*(torch.cat(column) if isinstance(column[0], torch.Tensor)
                     else np.concatenate(column) for column in columns))


def generate(profiles, start, episodes, archive=None, stride=3):
    rng = np.random.default_rng(start)
    columns = [list() for _ in range(7)]
    cause = load("cause-gru") if archive is not None else None
    predictor = load("world-gru") if archive is not None else None
    for profile in profiles:
        for seed in range(start, start+episodes):
            world = make_world(seed, profile, normal=seed%7==0)
            frames = np.stack([world.observe()]*HISTORY)
            while not world.state.done:
                tick = world.state.now
                obs = frames[-1]
                legal = np.flatnonzero(allowed(obs))
                action = strong_rules(obs) if rng.random() < .53 else int(rng.choice(legal[legal!=2]))
                if action == 2:
                    action = 1   # retain trajectories after a simulated referral during collection
                sampled = tick % stride == seed % stride
                if sampled:
                    truth = world.state.roots.flatten().copy()
                    mask, values, effects, base = paired_targets(world, obs)
                    tag = "normal" if not truth.any() else "compound" if truth.sum()>1 else "single"
                    row = (frames.copy(), truth, base, mask, values, effects, profile+":"+tag)
                    for store, item in zip(columns, row):
                        store.append(item)
                before = world.state.lost.sum()
                event = world.step(action)
                after = world.observe()
                if sampled and archive is not None:
                    with torch.inference_mode():
                        encoded = torch.tensor(frames[None])
                        probs = cause(encoded).sigmoid()[0].numpy()
                        predicted = predictor(encoded, torch.tensor([action])).sigmoid()[0,:WIDTH].numpy()
                    observed = after >= 0
                    error = np.abs(predicted[observed]-after[observed]).mean()
                    severe = (world.state.lost.sum()>before or event["unnecessary"] or event["blocked"])
                    archive.add(Episode(VERSION[profile], profile, seed, tick, frames.tolist(), truth.tolist(),
                        probs.tolist(), action, after.tolist(), event, float(abs(probs-.5).mean()*2),
                        float(error), bool(severe)))
                frames = np.concatenate((frames[1:], after[None]))
    return Samples(*(torch.from_numpy(np.asarray(column)) for column in columns[:-1]), np.asarray(columns[-1]))


class Learner(nn.Module):
    def __init__(self, transfer=True):
        super().__init__()
        self.encoder = nn.GRU(WIDTH, 32, batch_first=True)
        self.diagnose = nn.Linear(32, 2*ROOT_COUNT)
        self.forecast = nn.Linear(32, WIDTH+1)
        self.value = nn.Linear(32, N)
        self.effect = nn.Linear(32, N)
        if transfer:
            old = load("cause-gru")
            self.encoder.load_state_dict(old.engine.state_dict())
            self.diagnose.load_state_dict(old.head.state_dict())
            old = load("world-gru")
            with torch.no_grad():
                self.forecast.weight.copy_(old.head.weight[:,:32])
                self.forecast.bias.copy_(old.head.bias + old.head.weight[:,32])

    def forward(self, inputs):
        rep = self.encoder(inputs)[0][:,-1]
        return self.diagnose(rep), self.forecast(rep), self.value(rep), self.effect(rep)


def loss_for(model, data):
    cause, future, values, effects = model(data.histories)
    root = F.binary_cross_entropy_with_logits(cause, data.roots.float(), reduction="none").mean(1)
    forecast = F.smooth_l1_loss(future.sigmoid(), data.base, reduction="none").mean(1)
    value_weight = 1 + data.values.abs().clamp(max=1)
    regression = (F.smooth_l1_loss(values, data.values, reduction="none")*value_weight +
                  F.smooth_l1_loss(effects, data.effects, reduction="none"))*data.mask
    return 2*root + 1.1*forecast + regression.sum(1)/data.mask.sum(1)


def fit(model, rows, validation, epochs, seed, save=None, strategy="mixed", replay=None,
        teacher=None, priorities=None, resume=False):
    rng = np.random.default_rng(seed)
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=.003)
    curve = []
    if resume:
        checkpoint = torch.load(save, weights_only=True)
        model.load_state_dict(checkpoint["weights"])
        optimizer.load_state_dict(checkpoint["optimizer"])
        rng.bit_generator.state = checkpoint["rng"]
        curve = checkpoint["curve"]
    def objective(batch):
        if strategy!="imitation":
            return loss_for(model,batch)
        target = batch.values.masked_fill(~batch.mask,-torch.inf).argmax(1)
        _,_,estimate,_ = model(batch.histories)
        return F.cross_entropy(estimate.masked_fill(~batch.mask,-torch.inf),target,reduction="none")

    initial = len(curve)
    begin = perf_counter()
    for _ in range(initial, epochs):
        model.train()
        sequence = rng.permutation(len(rows)) if priorities is None else rng.choice(
            len(rows), len(rows), p=priorities/priorities.sum(), replace=True)
        losses = []
        for indices in np.array_split(sequence, max(1, int(np.ceil(len(sequence)/96)))):
            batch = rows.take(indices)
            if replay is not None:
                # Replay quota is equal for uniform and prioritized replay.
                weights = None
                if strategy == "prioritized":
                    with torch.no_grad():
                        weights = loss_for(model, replay).numpy() + .15
                    weights /= weights.sum()
                old_ix = rng.choice(len(replay), min(len(indices), max(1,len(replay)//5)),
                                    replace=False, p=weights)
                batch = Samples.join(batch, replay.take(old_ix))
            error = objective(batch).mean()
            if teacher is not None:
                with torch.no_grad():
                    soft_cause, soft_base, _, _ = teacher(batch.histories)
                cause, base, _, _ = model(batch.histories)
                error += 1.4*F.mse_loss(cause.sigmoid(),soft_cause.sigmoid()) + F.mse_loss(base.sigmoid(),soft_base.sigmoid())
            optimizer.zero_grad()
            error.backward()
            optimizer.step()
            losses.append(float(error.detach()))
        model.eval()
        with torch.inference_mode():
            valid = float(objective(validation).mean())
        curve.append({"train_loss": float(np.mean(losses)), "validation_loss": valid})
        if save:
            temp = save.with_suffix(".tmp")
            torch.save({"weights": model.state_dict(), "optimizer": optimizer.state_dict(),
                         "rng": rng.bit_generator.state, "curve": curve}, temp)
            temp.replace(save)
    return {"curve":curve,"seconds":perf_counter()-begin}


def reload(path):
    model = Learner(transfer=False)
    model.load_state_dict(torch.load(Path(path), weights_only=True)["weights"])
    return model.eval()
