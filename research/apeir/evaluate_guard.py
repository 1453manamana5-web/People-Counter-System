"""Evaluate abstention and rule/model agreement on a new compound-fault set."""

import json
from pathlib import Path

import numpy as np

from train import baseline, metrics, predict

MISSING_ANOMALY_COST = 10


def challenge():
    rng = np.random.default_rng(310031)
    expected = np.tile(np.arange(5), 400)
    rows = np.tile([1, 1, 1, 1, 0, 1], (len(expected), 1))
    rows[expected == 1, 3] = 0
    rows[expected == 2, 1] = 0
    rows[expected == 3, 2] = 0
    # An ambiguous scenario has two concurrent faults and needs operator review.
    for index in np.flatnonzero(expected == 4):
        rows[index, rng.choice(4, 2, replace=False)] = 0
    stale = rng.random(len(rows)) < 0.20
    rows[stale, 0] = -1
    rows[rng.random(rows.shape) < 0.12] = -1
    return rows, expected


def main():
    artifact = json.loads(Path(__file__).with_name("weights.json").read_text())
    rows, expected = challenge()
    rules = baseline(rows)
    model = predict(rows, np.array(artifact["weights"]), artifact["threshold"])
    agreed = np.where(rules == model, rules, 4)
    # Require affirmative telemetry before treating a station as normal.
    complete_healthy = np.all(rows == [1, 1, 1, 1, 0, 1], axis=1)
    guarded = np.where((agreed == 0) & ~complete_healthy, 4, agreed)
    result = {"cases": len(rows), "miss_cost": MISSING_ANOMALY_COST, "methods": {}}
    for name, answers in (("rules", rules), ("model", model), ("guarded_agreement", guarded)):
        summary = metrics(expected, answers)
        summary["weighted_errors"] = int(np.sum(answers != expected)) + (
            MISSING_ANOMALY_COST - 1
        ) * summary["false_observe"]
        summary["healthy_referred"] = int(np.sum((expected == 0) & (answers == 4)))
        result["methods"][name] = summary
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
