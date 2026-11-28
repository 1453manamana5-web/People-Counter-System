import json
from pathlib import Path
import unittest

import numpy as np

from benchmark_world import BenchmarkWorld, SEEDS, Scenario, label_world, scenarios
from core import possible_plans, verify_operation
from world import allowed


class IntelligenceTests(unittest.TestCase):
    def test_persistent_fault_stays_until_legal_recovery(self):
        world=BenchmarkWorld(Scenario("camera",520,False))
        world.state.visible[:]=world.state.authorized[:]=True
        for _ in range(8):
            world.step(0)
        self.assertTrue(world.state.roots[0,1])
        while not allowed(world.observe())[5]:
            world.step(0)
        world.shocks[world.state.now,0,7]=0
        before=world.observe()
        event=world.step(5)
        self.assertFalse(event["blocked"])
        self.assertFalse(world.state.roots[0,1])
        self.assertIn(verify_operation(5,before,world.observe()),("observed","unknown"))

    def test_labels_are_paired_and_do_not_advance_original(self):
        world=BenchmarkWorld(Scenario("compound",620,False))
        before=world.observe().copy()
        _,_,gains,mask,_=label_world(world,before)
        self.assertEqual(world.state.now,0)
        np.testing.assert_array_equal(before,world.observe())
        self.assertTrue(mask[0,0])
        self.assertFalse(gains[0,0].any())
        self.assertTrue(all(allowed(before)[first] for first,_ in possible_plans(before)))

    def test_all_splits_disjoint_and_balanced(self):
        seeds=set()
        for split in SEEDS:
            cases=scenarios(split)
            population={len([case for case in cases if case.group==group]) for group in {case.group for case in cases}}
            self.assertEqual(len(population),1)
            self.assertFalse(seeds.intersection(case.seed for case in cases))
            seeds.update(case.seed for case in cases)

    def test_production_contract_truth_table_and_missing_verification(self):
        path=Path(__file__).with_name("artifacts")/"knowledge.json"
        data=json.loads(path.read_text())
        for row in data["controls"]:
            inputs=row["input"]
            obs=np.ones(23,dtype=np.float32)
            obs[1]=0
            obs[5]=inputs["tracking"]
            obs[6]=inputs["visible"]
            obs[7]=inputs["verified"]
            obs[8]=inputs["attempts"]==0
            obs[3]=inputs["enabled"]
            self.assertEqual(allowed(obs)[5],row["accepted"])
        self.assertEqual(verify_operation(5,obs,np.full(23,-1)),"unknown")

    def test_knowledge_registry_links_are_resolvable(self):
        path=Path(__file__).with_name("artifacts")/"knowledge.json"
        data=json.loads(path.read_text())
        identifiers={item["id"] for item in data["capabilities"]}
        self.assertEqual(len(identifiers),18)
        for item in data["capabilities"]:
            self.assertTrue(set(item["related"])<=identifiers)
        self.assertIn("verify",data["lifecycleGuards"]["finished"])
        self.assertNotIn("open",data["lifecycleGuards"]["closing"])
        self.assertIn("sync",data["stationActions"])
        self.assertIn("stale",data["stationResults"])


if __name__=="__main__":
    unittest.main()
