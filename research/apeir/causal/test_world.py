from copy import deepcopy
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import numpy as np

from planning import Planner
from train import HISTORY, contrast, load
from world import WIDTH, World, allowed


class WorldTests(unittest.TestCase):
    def test_repeat_simulator_seed_and_different_interventions(self):
        a=World(9)
        b=deepcopy(a)
        np.testing.assert_array_equal(a.observe(),b.observe())
        a.state.roots[:]=False
        b.state.roots[:]=False
        a.state.roots[0,1]=b.state.roots[0,1]=True
        a.state.persistent[0,1]=b.state.persistent[0,1]=True
        before=b.shocks.copy()
        b.intervention(0,1)
        a.step(0); b.step(0)
        np.testing.assert_array_equal(a.shocks,before)
        self.assertEqual(a.observe(clean=True)[1],0)
        self.assertEqual(b.observe(clean=True)[1],1)
        self.assertNotEqual(a.observe(clean=True)[2],b.observe(clean=True)[2])

    def test_paired_probe_does_not_modify_original(self):
        w=World(24,"busy")
        before=w.state.roots.copy()
        self.assertEqual(contrast(w).shape,(60,))
        np.testing.assert_array_equal(w.state.roots,before)
        self.assertEqual(w.state.now,0)

    def test_sync_delivers_once_to_management(self):
        w=World(11)
        w.state.roots[:]=False
        w.state.queues[:]=0
        w.state.queues[0]=1
        w.shocks[:,:,:]=.98
        self.assertTrue(allowed(w.observe())[3])
        self.assertFalse(w.step(3)["blocked"])
        self.assertEqual(w.state.counts[0],1)
        w.step(0)
        self.assertEqual(w.state.counts[0],1)

    def test_protected_actuation_matches_production_contract_on_shared_inputs(self):
        app=Path(__file__).resolve().parents[3]/"counter-app/public/people-counter/luxnora-core.mjs"
        cases=[
            dict(verified=True,visible=True,tracking=0,attempts=0,enabled=True),
            dict(verified=True,visible=False,tracking=0,attempts=0,enabled=True),
            dict(verified=True,visible=True,tracking=1,attempts=0,enabled=True),
            dict(verified=True,visible=True,tracking=0,attempts=1,enabled=True),
            dict(verified=False,visible=True,tracking=0,attempts=0,enabled=True),
            dict(verified=True,visible=True,tracking=0,attempts=0,enabled=False),
        ]
        source=f'import {{recoveryDecision}} from {json.dumps(app.as_uri())}; const x={json.dumps(cases)}; console.log(JSON.stringify(x.map(recoveryDecision)));'
        app_results=json.loads(subprocess.check_output(["node","--input-type=module","-e",source]))
        sim=[]
        for item in cases:
            obs=np.ones(WIDTH)
            obs[1]=0;obs[3]=1
            obs[5]=item["tracking"];obs[6]=item["visible"]
            obs[7]=item["verified"] and item["enabled"];obs[8]=not item["attempts"]
            sim.append(bool(allowed(obs)[5]))
        self.assertEqual(sim,app_results)

    def test_planner_cannot_infer_new_permissions(self):
        planner=Planner()
        current=np.ones(WIDTH,np.float32)
        current[1]=0;current[5]=1;current[7]=0
        current[4]=current[14]=0
        with patch.object(planner,"transitions",side_effect=AssertionError("no candidate should reach model")):
            action,called=planner.best(np.stack([current]*HISTORY))
        self.assertFalse(called)
        self.assertTrue(allowed(current)[action])
        self.assertNotIn(action,range(5,9))

    def test_saved_transition_models_condition_on_action(self):
        w=World(20)
        x=np.stack([w.observe()]*HISTORY)
        planner=Planner()
        means,spread=planner.transitions([x,x],[0,5])
        self.assertEqual(means.shape,(2,WIDTH+1))
        self.assertFalse(np.allclose(means[0],means[1]))
        self.assertTrue(np.isfinite(spread).all())
        self.assertEqual(load("paired-effect").task,"effect")

    def test_world_rechecks_actions_independent_of_model(self):
        w=World(19)
        w.state.tracking[:]=1
        before=w.state.credit.copy()
        event=w.step(5)
        self.assertTrue(event["blocked"])
        self.assertEqual(event["action"],1)
        np.testing.assert_array_equal(w.state.credit,before)


if __name__=="__main__":
    unittest.main()
