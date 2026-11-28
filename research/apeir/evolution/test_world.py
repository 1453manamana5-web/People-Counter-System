import unittest

import numpy as np

from world import Action, ApeirWorld, guarded, permitted


class WorldTests(unittest.TestCase):
    def test_seed_and_action_replay(self):
        a,b=ApeirWorld(distribution="novel"),ApeirWorld(distribution="novel")
        oa,_=a.reset(seed=777)
        ob,_=b.reset(seed=777)
        np.testing.assert_array_equal(oa,ob)
        for _ in range(6):
            na,ra,ta,ua,ia=a.step(Action.WAIT)
            nb,rb,tb,ub,ib=b.step(Action.WAIT)
            np.testing.assert_array_equal(na,nb)
            self.assertEqual((ra,ta,ua,ia["problem"]),(rb,tb,ub,ib["problem"]))
            if ta or ua:
                break

    def prepare(self, faults):
        env=ApeirWorld(level=0)
        env.reset(seed=42)
        env.faults[:]=faults
        env.persistent[:]=False
        env.durable=0
        env.visible=env.authorized=True
        return env

    def test_guard_rejects_restart_during_active_track_and_does_not_restart(self):
        env=self.prepare([False,True,False,False])
        env.tracking=1
        env.frames[-1][:]=[1,0,1,1,1,0,1,1,1,1,0]
        result=env.step(Action.CAMERA)[-1]
        self.assertTrue(result["blocked"])
        self.assertEqual(result["action"],Action.ASK)
        self.assertEqual(env.attempts,0)
        self.assertTrue(env.faults[1])

    def test_unknown_access_or_budget_denies_restart(self):
        obs=np.ones((4,11),dtype=np.float32)
        obs[-1,1]=obs[-1,6]=0
        self.assertTrue(permitted(obs)[Action.CAMERA])
        for column in (0,7,8,9):
            changed=obs.copy()
            changed[-1,column]=-1
            self.assertEqual(guarded(changed,Action.CAMERA),Action.ASK)

    def test_actions_have_different_future_queue_state(self):
        wait=self.prepare([False,False,False,False])
        sync=self.prepare([False,False,False,False])
        for env in (wait,sync):
            env.durable=6
            env.frames[-1][:]=[1,1,1,1,1,1,0,1,1,1,0]
        wait.step(Action.WAIT)
        sync.step(Action.SYNC)
        self.assertGreater(wait.durable,sync.durable)
        self.assertEqual(sync.durable,1)

    def test_recovery_requires_two_terminal_checks(self):
        env=self.prepare([False,False,False,False])
        self.assertFalse(env.step(Action.WAIT)[2])
        self.assertTrue(env.step(Action.WAIT)[-1]["recovered"])

    def test_reports_and_authority_are_distinct_inputs(self):
        env=self.prepare([True,True,False,False])
        env.authorized=False
        for _ in range(6):
            env._observe()
            obs=env.observation()
            self.assertFalse(permitted(obs)[Action.CAMERA])
            self.assertTrue(env.observation_space.contains(obs))


if __name__=="__main__":
    unittest.main()
