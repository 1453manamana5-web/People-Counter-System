"""Fit an isolated temporal telemetry classifier with an independent normality gate."""
import argparse
import json
from pathlib import Path

import numpy as np

from train import baseline, encode, metrics, predict, probabilities


def scenarios(split):
    seed, count, missing = {"train": (4200, 16000, .08), "validation": (4201, 2500, .13),
                             "independent": (4202, 4000, .20)}[split]
    rng = np.random.default_rng(seed)
    labels = rng.choice(5, count, p=[.35, .22, .16, .15, .12])
    frames = np.broadcast_to([1, 1, 1, 1, 0, 1], (count, 4, 6)).copy()
    axes = {1: (0, 3), 2: (1,), 3: (2, 4)}
    for i, label in enumerate(labels):
        if label == 0:
            continue
        start = rng.integers(0, 3)
        if label == 4:
            cols = rng.choice([0, 1, 2, 3], 2, replace=False)
        else:
            cols = axes[label]
        frames[i, start:, cols] = 0
        if label in (1, 3) and rng.random() < .7:
            frames[i, start:, 4] = 1
        if split == "independent" and i % 7 == 0:
            # Recovery and delayed telemetry obscure one originally active signal.
            frames[i, -1, cols] = 1
    flips = rng.random(frames.shape) < (.04 if split == "independent" else .02)
    frames[flips] = 1 - frames[flips]
    frames[rng.random(frames.shape) < missing] = -1
    return frames, labels


def classify(frames, weights, threshold):
    scored = probabilities(encode(frames.reshape(len(frames), -1)) @ weights)
    labels = scored.argmax(axis=1)
    labels[scored.max(axis=1) < threshold] = 4
    # The last sample and at least one earlier sample must independently agree.
    clean = np.all(frames == [1, 1, 1, 1, 0, 1], axis=2)
    labels[(labels == 0) & ~(clean[:, -1] & clean[:, :-1].any(axis=1))] = 4
    labels[frames[:, -1, -1] != 1] = 4
    return labels


def temporal_rules(frames):
    # Give the deterministic baseline the same four samples. Keep conflicting
    # past/current fault categories under operator review.
    checks = baseline(frames.reshape(-1, 6)).reshape(len(frames), 4)
    current = checks[:, -1].copy()
    for index, history in enumerate(checks):
        faults = set(history) & {1, 2, 3}
        if len(faults) > 1 or current[index] == 0 and (faults or 0 not in history[:-1]):
            current[index] = 4
    return current


def report(expected, observed):
    result = metrics(expected, observed)
    result["weighted_errors"] = int(np.sum(expected != observed)) + 9 * result["false_observe"]
    return result


def main(output):
    frames, expected = scenarios("train")
    encoded = encode(frames.reshape(len(frames), -1))
    targets = np.eye(5)[expected]
    weights = np.zeros((encoded.shape[1], 5))
    for _ in range(200):
        diff = probabilities(encoded @ weights) - targets
        weights -= .4 * (encoded.T @ diff / len(frames) + .002 * weights)
    validation, labels = scenarios("validation")
    threshold = min((.4, .5, .6, .7, .8, .9), key=lambda t: report(labels,classify(validation,weights,t))["weighted_errors"])
    independent, labels = scenarios("independent")
    previous = json.loads(Path(__file__).with_name("weights.json").read_text())
    result = {"training": len(frames), "validation": len(validation), "threshold": threshold,
              "rules": report(labels,baseline(independent[:, -1])),
              "temporal_rules": report(labels,temporal_rules(independent)),
              "alpha01": report(labels,predict(independent[:, -1],np.array(previous["weights"]),previous["threshold"])),
              "alpha02": report(labels,classify(independent,weights,threshold))}
    output.mkdir(parents=True,exist_ok=True)
    (output/"alpha02-weights.json").write_text(json.dumps({"features":"4 frames × 6 signals; one, zero, missing, bias",
                                                        "threshold":threshold,"weights":weights.tolist()},indent=2)+"\n")
    (output/"alpha02-metrics.json").write_text(json.dumps(result,indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args().output)
