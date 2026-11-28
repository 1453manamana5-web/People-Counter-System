"""Evaluate same-scope previous models and a frozen Ruri encoder with a trained head."""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from train import Classifier, DECISIONS, encode, fit, read_rows, scores, normalize
from oracle import CAPS

ROOT = Path(__file__).resolve().parent


def retrieve_v51(rows, name):
    with np.load(ROOT.parent / "luxnora-hybrid" / (name + ".npz")) as model:
        features = np.zeros((len(rows), 768), dtype=np.float32)
        for row, item in zip(features, rows):
            text = "^" + normalize(item["text"]) + "$"
            for start in range(len(text)):
                code = 0
                for char in text[start:start + 3]:
                    code = (code * 31 + ord(char)) % 768
                    row[code] = 1
            row /= max(1, np.linalg.norm(row))
        hidden = features @ (model["first"].astype(np.float32) * model["scale"])
        if "last" in model:
            hidden = np.tanh(hidden)
            logits = hidden @ model["last"]
        else:
            logits = hidden
        probabilities = np.exp(logits - logits.max(axis=1, keepdims=True))
        probabilities /= probabilities.sum(axis=1, keepdims=True)
        results = []
        for i, (best, second, *_) in enumerate(np.argsort(-probabilities, axis=1, kind="stable")):
            passes = probabilities[i, best] >= model["cutoff"]
            passes &= probabilities[i, best] - probabilities[i, second] >= model["margin"]
            if "aux" in model:
                passes &= hidden[i] @ model["aux"] >= 0
            label = model["labels"][best] if passes else "abstain"
            results.append([] if label == "abstain" else [str(label)])
        return results


def compare_guidance(rows, checkpoint):
    label_union = set()
    for variant in ("linear", "mlp", "multitask"):
        with np.load(ROOT.parent / "luxnora-hybrid" / (variant + ".npz")) as model:
            label_union.update(str(label) for label in model["labels"])
    rows = [row for row in rows if row["expected"]["intent"] == "outside" or
            (row["expected"]["intent"] == "guide" and row["expected"]["capabilities"][0] in label_union)]

    def evaluate(predictions):
        counts = dict(correct_answer=0, wrong_guide=0, excessive_hold=0, correct_hold=0, out_of_scope_guide=0)
        for row, predicted in zip(rows, predictions, strict=True):
            expected = row["expected"]["capabilities"]
            if expected == predicted:
                counts["correct_answer" if predicted else "correct_hold"] += 1
            elif not expected:
                counts["out_of_scope_guide"] += 1
            elif not predicted:
                counts["excessive_hold"] += 1
            else:
                counts["wrong_guide"] += 1
        return counts

    model = Classifier(checkpoint["kind"], len(checkpoint["vocabulary"]) + 2, len(checkpoint["attributes"]))
    model.load_state_dict(checkpoint["weights"])
    batch = encode(rows, checkpoint["vocabulary"], checkpoint["attributes"])
    _, decisions, choices, _ = scores(model.eval(), batch, checkpoint["threshold"], detailed=True)
    candidates = [[key for key, flag in zip(CAPS, selected) if flag] if DECISIONS[category[1]] in ("answer", "partial")
                  else [] for category, selected in zip(decisions, choices)]
    return {
        "cases": len(rows),
        "unique_utterances": len({row["text"] for row in rows}),
        "in_scope_cases": sum(bool(row["expected"]["capabilities"]) for row in rows),
        "methods": {**{"v5.1-" + name: evaluate(retrieve_v51(rows, name)) for name in ("linear", "mlp", "multitask")},
                    "v5.2-multitask": evaluate(candidates)},
    }


def ruri(splits, checkpoint, feature_file, output):
    asset = json.loads(feature_file.read_text())
    vectors = dict(zip(asset["texts"], asset["vectors"], strict=True))
    data = {}
    for name, rows in splits.items():
        ngrams, sequence, context, single, multi = encode(rows, checkpoint["vocabulary"], checkpoint["attributes"])
        semantic = torch.tensor([vectors[row["text"]] for row in rows], dtype=torch.float32)
        # A fixed 512-wide interface lets both heads use identical settings.
        if semantic.shape[1] > ngrams.shape[1]:
            raise ValueError("Ruri output wider than comparison interface")
        semantic = torch.nn.functional.pad(semantic, (0, ngrams.shape[1] - semantic.shape[1]))
        data[name] = (semantic, sequence, context, single, multi)
    model, threshold, curve, seconds = fit("mlp", data["train"], data["validation"], checkpoint["vocabulary"],
                                           checkpoint["attributes"], 16, "mixed", 5201)
    torch.save({"kind": "mlp", "encoder": "ruri-v3-30m-q8", "weights": model.state_dict(),
                "threshold": threshold, "attributes": checkpoint["attributes"]}, output / "ruri-head.pt")
    evaluation = {name: scores(model, row, threshold) for name, row in data.items() if name != "train"}
    repeats = []
    for seed in (5202, 5203):
        alternate, cut, _, elapsed = fit("mlp", data["train"], data["validation"], checkpoint["vocabulary"],
                                          checkpoint["attributes"], 16, "mixed", seed)
        repeats.append({"seed": seed, "seconds": elapsed, "threshold": cut,
                        "validation": scores(alternate, data["validation"], cut),
                        "independent": scores(alternate, data["independent"], cut)})
    return {"seconds_training_head": seconds, "threshold": threshold, "curve": curve, "repeats": repeats,
            "unique_texts_embedded": len(vectors), **{name: asset[name] for name in ("loadMs", "extractMs", "sizes")},
            **evaluation}


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("data", type=Path)
    args.add_argument("artifacts", type=Path)
    args.add_argument("--ruri-features", type=Path)
    args = args.parse_args()
    checkpoint = torch.load(args.artifacts / "mlp-5000.pt", weights_only=True)
    splits = {name: read_rows(args.data, name) for name in ("train", "validation", "independent", "conversation")}
    comparison = {"guidance": compare_guidance(splits["independent"], checkpoint)}
    if args.ruri_features:
        comparison["ruri"] = ruri(splits, checkpoint, args.ruri_features, args.artifacts)
    (args.artifacts / "additional-eval.json").write_text(json.dumps(comparison, indent=2) + "\n")
