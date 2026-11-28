import unittest

from generate import audit, conversations, scenarios, select
from oracle import label


class ResearchTests(unittest.TestCase):
    def test_comparison_dependency_requires_verified_lower_live_count(self):
        query = {"task": "conditional", "period": "午前"}
        for past, comparison, mode, ordered in (
            ("verified", "lower", "live", True),
            ("verified", "equal", "live", False),
            ("missing", "lower", "live", False),
            ("verified", "lower", "test", False),
        ):
            result = label(query, {"past": past, "comparison": comparison, "mode": mode})
            self.assertEqual(result["ordered_diagnosis"], ordered)
            self.assertEqual("station.health" in result["capabilities"], ordered)

    def test_important_request_requires_right_authority_and_state(self):
        state = {"authorized": True, "stage": "finished", "mode": "live", "review": "ready", "finalized": False}
        query = {"task": "approve", "operation": "集計確定"}
        self.assertEqual(label(query, state)["decision"], "confirm")
        for field, value in (("authorized", False), ("mode", "test"), ("review", "unsynced"),
                             ("finalized", True), ("stage", "closing")):
            self.assertEqual(label(query, {**state, field: value})["decision"], "blocked")
        self.assertEqual(label({"task": "negate"}, state)["decision"], "cancel")

    def test_correction_carries_reference_only_when_unambiguous(self):
        query = {"task": "reference", "period": "午前"}
        clear = label(query, {"prior": "compare", "focus": "exit", "past": "missing"})
        self.assertEqual((clear["role"], clear["capabilities"], clear["decision"]),
                         ("exit", ["analysis.compare"], "partial"))
        unclear = label(query, {"prior": "ambiguous", "focus": "exit"})
        self.assertEqual((unclear["capabilities"], unclear["decision"]), ([], "clarify"))

    def test_frozen_split_contract(self):
        splits = {name: select(scenarios(name, 12520 + i), expected) for i, (name, expected) in
                  enumerate((("train", 5000), ("validation", 1000), ("independent", 1000)))}
        splits["conversation"] = conversations()
        quality = audit(splits)
        self.assertEqual([summary["records"] for summary in quality.values()], [5000, 1000, 1000, 200])
        self.assertTrue(all(quality[name]["context_contrasts"] for name in splits))


if __name__ == "__main__":
    unittest.main()
