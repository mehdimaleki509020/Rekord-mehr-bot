#!/usr/bin/env python3
"""Extract Mehr baseline and Aban-to-date non-electric sales from SalesReport.xlsb.

Includes *all* sellers appearing in either month (including new starters), plus
the full non-electric turnover of each branch, even unassigned sales. Amounts
in the output are millions of toman. Each upload is a complete replacement
snapshot, not a daily delta.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

CATEGORY = "خانگی غیر برقی"
RIAL_PER_MILLION_TOMAN = 10_000_000.0
YEAR = 1405
MEHR_MONTH = 7
ABAN_MONTH = 8
REQUIRED_HEADERS = {"مشاور فروش", "نام فروشگاه", "PH11", "شماره ماه", "سال"}
AMOUNT_HEADERS = ("مبلغ کل صحیح", "خالص+کارمزد صحیح")


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", "" if value is None else str(value))
    text = text.translate(str.maketrans({
        "ي": "ی", "ى": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه",
        "ؤ": "و", "إ": "ا", "أ": "ا", "ٱ": "ا", "آ": "ا", "ئ": "ی", "ـ": " ",
    })).replace("\u200c", " ").replace("\u200e", " ").replace("\u200f", " ")
    text = "".join(ch for ch in text if unicodedata.category(ch) not in {"Mn", "Cf"})
    return re.sub(r"\s+", " ", text).strip().lower()


def compact(value: Any) -> str:
    return re.sub(r"[^0-9A-Za-z\u0600-\u06FF]", "", collapse_repetition(normalize(value)))


def collapse_repetition(text: str) -> str:
    tokens = text.split()
    for size in range(1, len(tokens) // 2 + 1):
        if len(tokens) % size == 0:
            block = tokens[:size]
            if all(tokens[index] == block[index % size] for index in range(len(tokens))):
                return " ".join(block)
    return text


def name_signature(value: Any) -> str:
    return "|".join(sorted(collapse_repetition(normalize(value)).split()))


def int_value(value: Any) -> int:
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return 0


def float_value(value: Any) -> float:
    try:
        num = float(str(value).replace(",", ""))
        return num if math.isfinite(num) else 0.0
    except (ValueError, TypeError):
        return 0.0


def aggregate(rows: Iterable[dict]) -> dict:
    sellers = {}
    stores = {}
    days = set()
    mehr_rows = aban_rows = 0
    for item in rows:
        if int_value(item["year"]) != YEAR:
            continue
        month = int_value(item["month"])
        if month not in (MEHR_MONTH, ABAN_MONTH):
            continue
        store = str(item["store"] or "").strip()
        store_key = compact(store)
        if not store_key:
            continue
        amount = float_value(item["amount_m"])
        if store_key not in stores:
            stores[store_key] = {
                "store": store, "store_key": store_key, "mehr_m": 0.0, "aban_m": 0.0,
            }
        field = "mehr_m" if month == MEHR_MONTH else "aban_m"
        stores[store_key][field] += amount
        if month == MEHR_MONTH:
            mehr_rows += 1
        else:
            aban_rows += 1
            day = int_value(item["day"])
            if 1 <= day <= 30:
                days.add(day)

        seller = str(item["seller"] or "").strip()
        seller_key = compact(seller)
        if not seller_key:
            # Still counted in whole-branch revenue for the supervisor criterion.
            continue
        # A doubled full name or shuffled word order must not create a fake
        # November new entrant with a 500M target.
        identity = (store_key, name_signature(seller))
        if identity not in sellers:
            sellers[identity] = {
                "store": store, "store_key": store_key,
                "seller_name": seller, "seller_key": f"{store_key}:{seller_key}",
                "mehr_m": 0.0, "aban_m": 0.0,
            }
        sellers[identity][field] += amount
        # Prefer the current month's display name if different.
        if month == ABAN_MONTH:
            sellers[identity]["seller_name"] = seller

    if not mehr_rows:
        raise ValueError("گزارش باید شامل تمام فروش غیربرقی مهر ۱۴۰۵ باشد؛ اطلاعات مهر یافت نشد.")
    if not aban_rows:
        raise ValueError("اطلاعات فروش آبان ۱۴۰۵ در فایل یافت نشد.")
    sorted_sellers = sorted(sellers.values(), key=lambda s: (s["store_key"], s["seller_key"]))
    sorted_stores = sorted(stores.values(), key=lambda s: s["store_key"])
    for rec in sorted_sellers + sorted_stores:
        rec["mehr_m"] = round(rec["mehr_m"], 5)
        rec["aban_m"] = round(rec["aban_m"], 5)
    for rec in sorted_sellers:
        rec["seller_key"] = f"{rec['store_key']}:{compact(rec['seller_name'])}"
    return {
        "period_year": YEAR, "period_month": ABAN_MONTH,
        "days_elapsed": max(days, default=0),
        "mehr_rows": mehr_rows, "aban_rows": aban_rows,
        "seller_count": len(sorted_sellers), "store_count": len(sorted_stores),
        "sales_m": round(sum(s["aban_m"] for s in sorted_stores), 5),
        "sellers": sorted_sellers, "stores": sorted_stores,
    }


def process_file(path: Path) -> dict:
    # Import here so the aggregation logic can be unit-tested without XLSB.
    from pyxlsb import open_workbook

    def cell_values(row):
        return [cell.v for cell in row]

    with open_workbook(str(path)) as book:
        if not book.sheets:
            raise ValueError("Excel workbook is empty")
        with book.get_sheet(1) as sheet:
            header_row = None
            index = {}
            for row_number, row in enumerate(sheet.rows(), start=1):
                values = cell_values(row)
                names = [normalize(value) for value in values]
                if {normalize(v) for v in REQUIRED_HEADERS}.issubset(set(names)):
                    header_row = row_number
                    index = {name: pos for pos, name in enumerate(names) if name}
                    break
                if row_number >= 30:
                    break
    if header_row is None:
        raise ValueError("ستون‌های اصلی گزارش SalesReport یافت نشد.")

    def col(name: str, required: bool = True):
        value = index.get(normalize(name))
        if required and value is None:
            raise ValueError(f"Missing column: {name}")
        return value

    amount_col = next((col(name, required=False) for name in AMOUNT_HEADERS if col(name, required=False) is not None), None)
    if amount_col is None:
        raise ValueError("ستون مبلغ فروش در فایل وجود ندارد.")
    year_col, month_col, day_col = col("سال"), col("شماره ماه"), col("روز", False)
    store_col, seller_col, category_col = col("نام فروشگاه"), col("مشاور فروش"), col("PH11")

    def records():
        with open_workbook(str(path)) as book:
            with book.get_sheet(1) as sheet:
                for row_number, row in enumerate(sheet.rows(), start=1):
                    if row_number <= header_row:
                        continue
                    values = cell_values(row)
                    def get(i):
                        return values[i] if i is not None and i < len(values) else None
                    if normalize(get(category_col)) != normalize(CATEGORY):
                        continue
                    yield {
                        "year": get(year_col), "month": get(month_col),
                        "day": get(day_col), "store": get(store_col),
                        "seller": get(seller_col),
                        "amount_m": float_value(get(amount_col)) / RIAL_PER_MILLION_TOMAN,
                    }

    return aggregate(records())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        output = process_file(args.input)
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: output[key] for key in (
            "period_year", "period_month", "days_elapsed", "seller_count", "store_count", "sales_m",
        )}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
