import unittest
from processor_azar import aggregate


class TestAzarProcessor(unittest.TestCase):
    def row(self, month, store, seller, amount, day=0, year=1405):
        return {"year": year, "month": month, "store": store,
                "seller": seller, "amount_m": amount, "day": day}

    def test_aban_and_azar_sales_are_separate(self):
        report=aggregate([
            self.row(8,"کرمان","علی رضایی",500,30),
            self.row(8,"کرمان","",100,30),
            self.row(9,"کرمان","علی رضایی",800,4),
            self.row(9,"کرمان","نیلوفر",500,4),
            self.row(9,"کرمان","",50,4),
            self.row(10,"کرمان","علی رضایی",999,1),
        ])
        self.assertEqual(report["period_year"],1405)
        self.assertEqual(report["period_month"],9)
        self.assertEqual(report["days_elapsed"],4)
        self.assertEqual(report["aban_rows"],2)
        self.assertEqual(report["azar_rows"],3)
        self.assertEqual(report["store_count"],1)
        self.assertEqual(report["stores"][0]["aban_m"],600)
        self.assertEqual(report["stores"][0]["azar_m"],1350)
        self.assertEqual(report["sales_m"],1350)
        self.assertEqual(report["seller_count"],2)

    def test_azar_only_export_is_accepted_for_archived_aban_restore(self):
        report=aggregate([self.row(9,"کرمانشاه","فروشنده جدید",401,3)])
        self.assertEqual(report["aban_rows"],0)
        self.assertEqual(report["azar_rows"],1)
        self.assertEqual(report["sellers"][0]["aban_m"],0)
        self.assertEqual(report["stores"][0]["azar_m"],401)

    def test_name_repetition_and_reordered_words_are_normalized(self):
        report=aggregate([
            self.row(8,"کرمانشاه","علی رضایی",500,30),
            self.row(9,"کرمانشاه","رضایی علی رضایی علی",600,2),
        ])
        self.assertEqual(report["seller_count"],1)
        self.assertEqual(report["sellers"][0]["aban_m"],500)
        self.assertEqual(report["sellers"][0]["azar_m"],600)

    def test_old_month_only_cannot_be_imported(self):
        with self.assertRaisesRegex(ValueError,"آذر"):
            aggregate([self.row(8,"ساری","علی",400,30)])


if __name__ == "__main__":
    unittest.main()
