"""Versioned episodic retention. Retrieval keys use only observable telemetry."""
import hashlib
from dataclasses import asdict, dataclass, field, replace
import json
from pathlib import Path

import numpy as np

RECORD_SCHEMA = 1


@dataclass
class Episode:
    version: str
    profile: str
    seed: int
    tick: int
    history: list
    roots: list
    candidate_causes: list
    action: int
    observed_after: list
    operation_outcome: dict
    certainty: float
    prediction_error: float
    serious: bool
    verified: bool = True
    repeats: int = 1

    def identity(self):
        contents = [self.version, self.profile, self.history, self.roots, self.action,
                    self.observed_after, self.operation_outcome, self.verified]
        return hashlib.sha256(json.dumps(contents, sort_keys=True).encode()).hexdigest()


@dataclass
class Archive:
    capacity: int
    active: dict = field(default_factory=dict)
    archived: dict = field(default_factory=dict)

    def add(self, item):
        key = item.identity()
        if key in self.active or key in self.archived:
            existing = self.active.get(key) or self.archived[key]
            existing.repeats += item.repeats
            existing.serious |= item.serious
            existing.prediction_error = max(existing.prediction_error, item.prediction_error)
            return
        (self.active if item.verified else self.archived)[key] = item
        if len(self.active) > self.capacity:
            self.retire(min(self.active, key=lambda k: (self.active[k].serious,
                        self.active[k].prediction_error, self.active[k].seed, self.active[k].tick)))

    def retire(self, key):
        self.archived[key] = self.active.pop(key)

    def restore(self, key, version, reverified=False):
        item = self.archived[key]
        if item.version != version or not (item.verified or reverified):
            return False
        del self.archived[key]
        verified = replace(item, verified=True)
        self.add(verified)
        return verified.identity() in self.active

    def save(self, path):
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps({"schema": RECORD_SCHEMA, "capacity": self.capacity,
                        "active": [asdict(item) for item in self.active.values()],
                        "archived": [asdict(item) for item in self.archived.values()]},
                        separators=(",", ":")))
        temp.replace(path)

    @classmethod
    def load(cls, path):
        record = json.loads(path.read_text())
        if record["schema"] != RECORD_SCHEMA:
            raise ValueError("Unsupported archive format")
        out = cls(record["capacity"])
        for section in ("active", "archived"):
            for entry in record[section]:
                item = Episode(**entry)
                getattr(out, section)[item.identity()] = item
        return out


class Search:
    def __init__(self, archive, version):
        self.rows = [row for row in archive.active.values() if row.verified and row.version == version]
        self.vectors = np.asarray([row.history for row in self.rows], dtype=np.float32)

    def find(self, history, k=5):
        if not self.rows:
            return [], float("inf")
        available = (self.vectors >= 0) & (history >= 0)
        delta = np.abs(self.vectors-history)
        distance = (delta*available).sum((1,2))/np.maximum(1, available.sum((1,2)))
        distance += .22*np.not_equal(self.vectors < 0, history < 0).mean((1,2))
        nearest = np.argsort(distance, kind="stable")[:k]
        return [self.rows[i] for i in nearest], float(distance[nearest[0]])
