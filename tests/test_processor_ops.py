import csv
import tempfile
import unittest
from pathlib import Path
from processor_ops import parse, ReportError

class TestOpsParser(unittest.TestCase):
    def run_csv(self,header,rows):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"input.csv"
            with path.open("w",encoding="utf-8-sig",newline="") as f:
                w=csv.writer(f);w.writerow(header);w.writerows(rows)
            return parse(path)
    def test_native_sales_detected_actual_headers_tax_returns_and_ranges(self):
        headers=["نام فروشگاه","مشاور فروش","PH11","PH21","سال","شماره ماه","روز","مبلغ کل صحیح","خالص+کارمزد صحیح"]
        kind,rows=self.run_csv(headers,[
            ["شعبه فرضی","فروشنده نمونه","خانگي غير برقي","پخت و پز",1405,9,"01",10000000,1],
            ["شعبه فرضی","فروشنده نمونه","خانگي غير برقي","پخت و پز",1405,9,"02",-2000000,1],
            ["شعبه فرضی","","خانگي غير برقي","پذيرايي و سرو",1405,9,"02",30000000,1],
            ["شعبه فرضی","فروشنده نمونه","خانگي غير برقي","پخت و پز",1405,8,"01",50000000,1],
            ["شعبه فرضی","فروشنده نمونه","لوازم برقي کوچک","پخت و پز",1405,9,"02",999999999,1],
        ])
        self.assertEqual(kind,"sales")
        personal=[r for r in rows if r["seller_key"] and r["period"]=="1405-09"]
        self.assertEqual(len(personal),1)
        self.assertEqual(personal[0]["value"],0.8)
        self.assertEqual(personal[0]["date_to"],"1405-09-02")
        self.assertEqual(personal[0]["group_code"],"cookware")
        self.assertEqual(sum(r["value"] for r in rows if not r["seller_key"] and r["period"]=="1405-09"),3.8)
    def test_inventory_flat_exact_duplicate_not_added(self):
        h=["نام فروشگاه","کد کالا","نام کالا","گروه کالا","تاریخ گزارش","موجودی تعدادی"]
        r=["شعبه فرضی","0001","قابلمه نمونه","پخت و پز","۱۴۰۵/۹/۱۴",10]
        kind,rows=self.run_csv(h,[r,r])
        self.assertEqual(kind,"inventory");self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["sku"],"0001");self.assertEqual(rows[0]["value"],10)
        with self.assertRaisesRegex(ReportError,"invalid_data"):
            self.run_csv(h,[r,r[:-1]+[11]])
    def test_traffic_and_plan_have_explicit_units_and_periods(self):
        kind,rows=self.run_csv(["نام فروشگاه","تاریخ گزارش","پاخور روزانه"],[["شعبه فرضی","1405-09-10",150]])
        self.assertEqual((kind,rows[0]["value"],rows[0]["date_to"]),("traffic",150,"1405-09-10"))
        kind,rows=self.run_csv(["نام فروشگاه","ماه شمسی","پلن غیربرقی (میلیون تومان)"],[["شعبه فرضی","1405-09",4000]])
        self.assertEqual((kind,rows[0]["value"],rows[0]["period"]),("plan",4000,"1405-09"))
    def test_unknown_layout_and_dates_quarantined(self):
        with self.assertRaisesRegex(ReportError,"unsupported_layout"):
            self.run_csv(["نام فروشگاه","موجودی","مبلغ"],[["شعبه فرضی",15,500]])
        with self.assertRaisesRegex(ReportError,"invalid_data"):
            self.run_csv(["نام فروشگاه","تاریخ گزارش","پاخور روزانه"],[["شعبه فرضی","1405-09-31",150]])
        with self.assertRaisesRegex(ReportError,"invalid_data"):
            self.run_csv(["نام فروشگاه","تاریخ گزارش","پاخور روزانه"],[["شعبه فرضی","1405-09-10",-5]])
