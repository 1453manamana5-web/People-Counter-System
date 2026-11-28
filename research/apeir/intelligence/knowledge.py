"""Read-only evidence and dependency access for structured research goals."""
import json
from pathlib import Path


class Knowledge:
    def __init__(self, path:Path):
        data=json.loads(path.read_text())
        if data["schema"]!=1:
            raise ValueError("Unsupported knowledge schema")
        self.revision=data["revision"]
        self.capabilities={entry["id"]:entry for entry in data["capabilities"]}
        self.lifecycle=data["lifecycleGuards"]
        self.actions=data["stationActions"]
        self.relations={row["id"]:row for row in data["relations"]}

    def answer(self, goal, value):
        if not isinstance(value,str):
            return None
        if goal=="lifecycle":
            commands=self.lifecycle.get(value)
            return {"commands":commands,"revision":self.revision} if commands is not None else None
        if goal=="dependencies":
            node=self.relations.get(value)
            return {"steps":node.get("steps",[]),"checks":node["checks"],"source":node["source"],
                    "revision":self.revision} if node is not None else None
        if goal=="capability":
            node=self.capabilities.get(value)
            return {"access":node["access"],"verification":node["verify"],"guide":node["guide"],
                    "source":node["source"],"revision":self.revision} if node is not None else None
        return None
