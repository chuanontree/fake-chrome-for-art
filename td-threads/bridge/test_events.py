"""事件引擎的單元測試: py -m unittest test_events (在 bridge 資料夾執行)"""
import random, unittest
from events import Engine, score, single_visit_velocity, STAGES

T0 = 1_760_000_000


def obs(i, t, replies, likes=10, **kw):
    return {"id": i, "t": t, "replies": replies, "likes": likes, "quotes": 0, "reposts": 0, "taken_at": T0 - 3600, **kw}


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.changes = []
        self.e = Engine("salt", {"quiet_min": 60}, on_change=lambda ev: self.changes.append((ev.hid, ev.stage)))

    def test_lifecycle_discover_heat_peak_cool_vanish(self):
        e, t = self.e, T0
        stages = []
        for step, replies in enumerate([10, 30, 70, 100, 110, 111]):
            ev = e.observe(obs("A", t + step * 900, replies))
            stages.append(STAGES[ev.stage])
        self.assertEqual(stages[0], "發現")
        self.assertIn("升溫", stages)
        self.assertIn("高峰", stages)
        self.assertEqual(stages[-1], "冷卻")
        gone = e.tick(t + 5 * 900 + 61 * 60)
        self.assertEqual([g.hid for g in gone], [e.hid("A")])
        self.assertEqual(STAGES[gone[0].stage], "消失")
        self.assertNotIn(e.hid("A"), e.events)

    def test_same_post_is_one_event(self):
        for k in range(5):
            self.e.observe(obs("A", T0 + k * 600, 10 + k, kw="炎上"))
            self.e.observe(obs("A", T0 + k * 600 + 5, 10 + k, kw="公審"))
        self.assertEqual(len(self.e.events), 1)
        self.assertEqual(self.e.events[self.e.hid("A")].keywords, {"炎上", "公審"})

    def test_vanished_event_returns_only_with_new_replies(self):
        e = self.e
        e.observe(obs("A", T0, 20))
        e.tick(T0 + 61 * 60)
        self.assertIsNone(e.observe(obs("A", T0 + 62 * 60, 20)))      # 同樣回覆數:不復活
        self.assertNotIn(e.hid("A"), e.events)
        ev = e.observe(obs("A", T0 + 63 * 60, 25))                     # 又有新回覆:同一個 ID 復活
        self.assertEqual(ev.hid, e.hid("A"))

    def test_ids_are_salted_hashes(self):
        h = self.e.hid("123456789")
        self.assertNotIn("123456789", h)
        self.assertNotEqual(h, Engine("other").hid("123456789"))
        self.assertEqual(len(h), 10)

    def test_score_bounds_and_ordering(self):
        calm = score({"replies": 3, "likes": 500, "velocity": 0.1})
        hot = score({"replies": 800, "likes": 300, "velocity": 40, "quotes": 60,
                     "sample_n": 40, "participants": 38, "deep_share": 0.5})
        self.assertGreaterEqual(calm, 0); self.assertLessEqual(hot, 1)
        self.assertLess(calm, 0.1); self.assertGreater(hot, 0.7)

    def test_single_visit_velocity(self):
        self.assertAlmostEqual(single_visit_velocity(60, T0 - 3600, T0), 10.0)
        self.assertEqual(single_visit_velocity(0, T0, T0), 0.0)

    def test_random_soak_no_duplicates_no_crash(self):
        rnd = random.Random(1)
        e, t, counts = self.e, T0, {}
        for step in range(5000):
            t += rnd.randint(5, 120)
            i = f"p{rnd.randint(0, 200)}"
            counts[i] = counts.get(i, rnd.randint(0, 50)) + rnd.choice([0, 0, 1, 3, 10])
            e.observe(obs(i, t, counts[i], likes=rnd.randint(0, 900), kw=rnd.choice(["炎上", "公審", "抵制"])))
            if step % 50 == 0:
                e.tick(t)
            self.assertEqual(len(e.events), len(set(e.events)))
            self.assertLessEqual(len(e.events), e.cfg["max_events"])
            for ev in e.events.values():
                self.assertTrue(0 <= ev.intensity <= 1)
        self.assertTrue(0 <= e.global_heat() <= 1)


if __name__ == "__main__":
    unittest.main()
