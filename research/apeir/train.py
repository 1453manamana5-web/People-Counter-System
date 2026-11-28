"""Train Apeir α-01 on simulated telemetry. Emits advisory labels only."""

import argparse
import json
from pathlib import Path

import numpy as np

FEATURES = ("heartbeat", "camera", "storage", "network", "pending", "visible")
LABELS = ("observe", "check_connection", "check_camera", "check_storage", "ask_operator")
SPLITS = {
    "train": (1453, 10_000, (0.04, 0.12), (0.00, 0.03)),
    "validation": (2027, 1_500, (0.08, 0.16), (0.01, 0.05)),
    "holdout": (2028, 2_000, (0.12, 0.28), (0.04, 0.08)),
}


def simulate(name):
    seed, count, dropout, contamination = SPLITS[name]
    rng = np.random.default_rng(seed)
    conditions = rng.choice(5, count, p=[0.42, 0.22, 0.16, 0.12, 0.08])
    # Hidden causes are sampled before observations are degraded.
    healthy = np.array([
        [0.97, 0.98, 0.99, 0.97, 0.06, 0.98],
        [0.24, 0.84, 0.96, 0.17, 0.78, 0.90],
        [0.91, 0.13, 0.96, 0.94, 0.14, 0.91],
        [0.88, 0.87, 0.15, 0.92, 0.70, 0.92],
        [0.54, 0.54, 0.55, 0.59, 0.47, 0.35],
    ])
    data = (rng.random((count, len(FEATURES))) < healthy[conditions]).astype(float)
    hidden = rng.random(data.shape) < rng.uniform(*dropout, size=(count, 1))
    flipped = rng.random(data.shape) < rng.uniform(*contamination, size=(count, 1))
    data[flipped] = 1 - data[flipped]
    data[hidden] = -1
    return data, conditions


def baseline(rows):
    answers = []
    for heartbeat, camera, storage, network, pending, visible in rows:
        if visible != 1:
            answers.append(4)
        elif storage == 0:
            answers.append(3)
        elif heartbeat == 0 or network == 0 or pending == 1:
            answers.append(1)
        elif camera == 0:
            answers.append(2)
        elif heartbeat == camera == storage == network == 1:
            answers.append(0)
        else:
            answers.append(4)
    return np.array(answers)


def encode(rows):
    return np.column_stack((rows == 1, rows == 0, rows == -1, np.ones(len(rows))))


def probabilities(logits):
    scores = np.exp(logits - logits.max(axis=1, keepdims=True))
    return scores / scores.sum(axis=1, keepdims=True)


def predict(rows, weights, threshold):
    scores = probabilities(encode(rows) @ weights)
    answers = scores.argmax(axis=1)
    answers[(scores.max(axis=1) < threshold) | (rows[:, -1] != 1)] = 4
    return answers


def metrics(expected, actual):
    return {
        "episodes": len(expected),
        "accuracy": round(float(np.mean(expected == actual)), 4),
        "operator_review": int(np.sum(actual == 4)),
        "false_observe": int(np.sum((expected != 0) & (actual == 0))),
        "confusion": [[int(np.sum((expected == i) & (actual == j)))
                       for j in range(len(LABELS))] for i in range(len(LABELS))],
    }


def main(output):
    rows, expected = simulate("train")
    encoded = encode(rows)
    targets = np.eye(len(LABELS))[expected]
    weights = np.zeros((encoded.shape[1], len(LABELS)))
    for _ in range(250):
        error = probabilities(encoded @ weights) - targets
        weights -= 0.5 * (encoded.T @ error / len(rows) + 0.001 * weights)

    validation, labels = simulate("validation")
    # Use validation only. Prefer fewer missed anomalies when accuracy ties.
    def score(threshold):
        report = metrics(labels, predict(validation, weights, threshold))
        return report["accuracy"], -report["false_observe"]

    threshold = max((0.4, 0.5, 0.6, 0.7, 0.8), key=score)
    holdout, labels = simulate("holdout")
    report = {
        "model": "Apeir α-01",
        "training_episodes": len(rows),
        "validation_episodes": len(validation),
        "features": FEATURES,
        "labels": LABELS,
        "threshold": threshold,
        "holdout_rules": metrics(labels, baseline(holdout)),
        "holdout_model": metrics(labels, predict(holdout, weights, threshold)),
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "weights.json").write_text(json.dumps({
        "features": FEATURES, "labels": LABELS, "threshold": threshold,
        "encoding": "one positive, zero, missing, bias",
        "weights": weights.tolist(),
    }, indent=2, ensure_ascii=False) + "\n")
    (output / "metrics.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args().output)
