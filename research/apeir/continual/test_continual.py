import tempfile
import unittest
from pathlib import Path

import numpy as np

from day import Day, fork, make_world, paired_targets
from memory import Archive, Episode, Search
from world import World, allowed


def episode(seed, verified=True, serious=False):
    return Episode("day-v1", "festival", seed, 1, [[0, seed]], [False], [0.2],
                   0, [[0, 0]], {"restored": False}, .4, .6, serious, verified=verified)


class ContinualTests(unittest.TestCase):
    def test_archive_retains_serious_and_isolates_unverified_versions(self):
        archive = Archive(2)
        for item in (episode(1, serious=True), episode(2), episode(2), episode(3), episode(4, verified=False)):
            archive.add(item)
        self.assertEqual(sum(r.repeats for r in archive.archived.values()), 3)
        self.assertEqual(sum(r.serious for r in archive.active.values()), 1)
        self.assertFalse(archive.restore(episode(4, verified=False).identity(), "day-v2", True))
        self.assertFalse(archive.restore(episode(4, verified=False).identity(), "day-v1"))
        self.assertTrue(archive.restore(episode(4, verified=False).identity(), "day-v1", True))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"archive.json"
            archive.save(path)
            restored = Archive.load(path)
            self.assertEqual(list(restored.active), list(archive.active))
            self.assertEqual(Search(restored,"day-v2").find(np.array([[0, 1]]))[0], [])
            self.assertEqual(Search(restored,"day-v1").find(np.array([[0, 1]]))[0][0].seed, 1)

    def test_long_day_is_reproducible_and_preserves_shared_action_guard(self):
        day = Day(341,"wireless")
        other = Day(341,"wireless")
        normal = make_world(341,"wireless",normal=True)
        active_ticks = 0
        for _ in range(96):
            np.testing.assert_array_equal(day.observe(),other.observe())
            self.assertFalse(normal.state.roots.any())
            active_ticks += int(day.state.roots.any())
            ticks = day.state.now
            legal = allowed(day.observe())
            day.step(int(np.flatnonzero(legal)[-1]))
            other.step(int(np.flatnonzero(legal)[-1]))
            normal.step(0)
            self.assertEqual(day.state.now,ticks+1)
        self.assertTrue(day.state.done)
        self.assertGreater(active_ticks, 15)
        self.assertEqual(World(1).horizon, 16)

    def test_paired_labels_do_not_mutate_world_or_expose_disallowed_actions(self):
        day = Day(532,"camera-shift")
        with self.assertRaises(ValueError):
            day.step(2.0)
        branch = fork(day)
        branch.state.roots[0,0] = True
        self.assertFalse(day.state.roots[0,0])
        before = day.observe().copy()
        mask, values, effects, _ = paired_targets(day,before)
        np.testing.assert_array_equal(mask,allowed(before))
        self.assertEqual(day.state.now,0)
        self.assertEqual(values[0],0)
        self.assertEqual(effects[0],0)
        self.assertFalse(effects[~mask].any())
        np.testing.assert_array_equal(before,day.observe())


if __name__ == "__main__":
    unittest.main()
