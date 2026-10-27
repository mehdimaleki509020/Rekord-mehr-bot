import unittest

from processor_aban import aggregate


class TestAbanProcessor(unittest.TestCase):
    def row(self, month, store, seller, amount, day=0):
        return {"year": 1405, "month": month, "store": store,
                "seller": seller, "amount_m": amount, "day": day}

    def test_new_sellers_and_full_branch_turnover(self):
        report = aggregate([
            self.row(7, "کرمانشاه", "فروشنده قدیمی", 700, 30),
            self.row(7, "کرمانشاه", "", 100, 30),
            self.row(8, "کرمانشاه", "فروشنده قدیمی", 840, 7),
            self.row(8, "کرمانشاه", "فروشنده جدید", 500, 7),
            self.row(8, "کرمانشاه", "", 60, 7),
        ])
        self.assertEqual(report["days_elapsed"], 7)
        self.assertEqual(report["store_count"], 1)
        self.assertEqual(report["seller_count"], 2)
        self.assertEqual(report["stores"][0]["mehr_m"], 800)
        self.assertEqual(report["stores"][0]["aban_m"], 1400)
        new = next(s for s in report["sellers"] if s["seller_name"] == "فروشنده جدید")
        self.assertEqual(new["mehr_m"], 0)
        self.assertEqual(new["aban_m"], 500)

    def test_no_october_baseline_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "مهر"):
            aggregate([self.row(8, "کرمانشاه", "فروشنده", 600, 7)])

    def test_repeated_and_reordered_names_keep_the_october_baseline(self):
        report = aggregate([
            self.row(7, "کرمانشاه", "علی رضایی", 700),
            self.row(8, "کرمانشاه", "رضایی علی رضایی علی", 840, 7),
        ])
        self.assertEqual(report["seller_count"], 1)
        self.assertEqual(report["sellers"][0]["mehr_m"], 700)
        self.assertEqual(report["sellers"][0]["aban_m"], 840)


if __name__ == "__main__":
    unittest.main()
