#!/usr/bin/env python3
"""Process a raw SalesReport .xlsb for the Rekord Mehr Bale bot.

Reads the newest (year, month) in the workbook, filters PH11 == خانگی غیر برقی,
matches only the 92 campaign sellers, and emits compact JSON for Cloudflare D1.
Amounts in SalesReport are rial; output sales_m is million toman.
"""

from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

from pyxlsb import open_workbook

CATEGORY = "خانگی غیر برقی"
RIAL_PER_MILLION_TOMAN = 10_000_000.0
REQUIRED_HEADERS = {"مشاور فروش", "نام فروشگاه", "PH11", "شماره ماه", "سال"}
AMOUNT_HEADERS = ("مبلغ کل صحیح", "خالص+کارمزد صحیح")


def normalize_text(value: Any) -> str:
    s = "" if value is None else str(value)
    s = unicodedata.normalize("NFKC", s)
    table = str.maketrans(
        {
            "ي": "ی",
            "ى": "ی",
            "ك": "ک",
            "ۀ": "ه",
            "ة": "ه",
            "ؤ": "و",
            "إ": "ا",
            "أ": "ا",
            "ٱ": "ا",
            "آ": "ا",
            "ئ": "ی",
            "ـ": " ",
        }
    )
    s = s.translate(table).replace("\u200c", " ").replace("\u200f", " ").replace("\u200e", " ")
    s = "".join(ch for ch in s if unicodedata.category(ch) not in {"Mn", "Cf"})
    s = re.sub(r"[^0-9A-Za-z\u0600-\u06FF]+", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def compact(value: Any) -> str:
    return re.sub(r"[^0-9A-Za-z\u0600-\u06FF]", "", normalize_text(value))


def token_signature(value: Any) -> str:
    return "".join(sorted(normalize_text(value).split()))


def as_int(value: Any) -> int:
    if value is None or value == "":
        return 0
    try:
        return int(float(value))
    except (TypeError, ValueError):
        m = re.search(r"-?\d+", normalize_text(value))
        return int(m.group()) if m else 0


def as_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        v = float(value)
        return v if math.isfinite(v) else 0.0
    except (TypeError, ValueError):
        s = str(value).replace(",", "").strip()
        try:
            return float(s)
        except ValueError:
            return 0.0


def row_values(row) -> list[Any]:
    return [cell.v for cell in row]


def find_header(input_path: Path) -> tuple[int, dict[str, int], str]:
    with open_workbook(str(input_path)) as wb:
        if not wb.sheets:
            raise RuntimeError("Workbook has no sheets")
        sheet_name = wb.sheets[0]
        with wb.get_sheet(1) as sh:
            for row_number, row in enumerate(sh.rows(), start=1):
                values = row_values(row)
                normalized = [normalize_text(v) for v in values]
                original = [str(v).strip() if v is not None else "" for v in values]
                idx_norm = {name: i for i, name in enumerate(normalized) if name}
                required_norm = {normalize_text(x) for x in REQUIRED_HEADERS}
                if required_norm.issubset(idx_norm):
                    idx: dict[str, int] = {}
                    for i, name in enumerate(original):
                        if name:
                            idx[name] = i
                    # Add normalized aliases so lookups survive Arabic/Persian glyph differences.
                    for i, name in enumerate(normalized):
                        if name:
                            idx[name] = i
                    return row_number, idx, sheet_name
                if row_number >= 30:
                    break
    raise RuntimeError("Could not find the SalesReport header row")


def index_for(idx: dict[str, int], name: str, required: bool = True) -> int | None:
    if name in idx:
        return idx[name]
    n = normalize_text(name)
    if n in idx:
        return idx[n]
    if required:
        raise RuntimeError(f"Missing required column: {name}")
    return None


def iter_data_rows(input_path: Path, header_row: int):
    with open_workbook(str(input_path)) as wb:
        with wb.get_sheet(1) as sh:
            for row_number, row in enumerate(sh.rows(), start=1):
                if row_number <= header_row:
                    continue
                yield row_values(row)


def safe_get(values: list[Any], i: int | None) -> Any:
    if i is None or i < 0 or i >= len(values):
        return None
    return values[i]


def load_targets(path: Path):
    targets = json.loads(path.read_text(encoding="utf-8"))
    if len(targets) != 92:
        raise RuntimeError(f"Expected 92 campaign sellers, got {len(targets)}")
    by_store: dict[str, list[dict[str, Any]]] = defaultdict(list)
    expanded = []
    for t in targets:
        if isinstance(t, list):
            if len(t) != 6:
                raise RuntimeError("Compact target row must have 6 fields")
            store, name, baseline_m, target20_m, target30_m, target40_m = t
            t = {
                "store": store, "name": name, "baseline_m": baseline_m,
                "target20_m": target20_m, "reward20_m": 1.0,
                "target30_m": target30_m, "reward30_m": 3.0,
                "target40_m": target40_m, "reward40_m": 5.0,
            }
        expanded.append(t)
        item = dict(t)
        item["_store"] = compact(item["store"])
        item["_name"] = compact(item["name"])
        item["_tok"] = token_signature(item["name"])
        item["_key"] = compact(item["name"])
        by_store[item["_store"]].append(item)
    return expanded, by_store


def match_target(by_store, store: Any, seller: Any):
    store_key = compact(store)
    name_key = compact(seller)
    tok = token_signature(seller)
    candidates = by_store.get(store_key, [])
    if not candidates or not name_key:
        return None, 0.0, "none"

    for t in candidates:
        if name_key == t["_name"]:
            return t, 1.0, "compact"
    for t in candidates:
        if tok and tok == t["_tok"]:
            return t, 0.995, "tokens"
    for t in candidates:
        c = t["_name"]
        if c and (name_key == c + c or (len(name_key) >= len(c) * 1.8 and name_key.replace(c, "") == "")):
            return t, 0.99, "duplicate"

    scored = []
    for t in candidates:
        a = difflib.SequenceMatcher(None, name_key, t["_name"]).ratio()
        b = difflib.SequenceMatcher(None, tok, t["_tok"]).ratio()
        scored.append((max(a, b), t))
    scored.sort(key=lambda x: x[0], reverse=True)
    if scored:
        best_score, best = scored[0]
        gap = best_score - (scored[1][0] if len(scored) > 1 else 0.0)
        if best_score >= 0.84 and gap >= 0.07:
            return best, best_score, "fuzzy"
        return None, best_score, "ambiguous"
    return None, 0.0, "none"


def find_latest_period(input_path: Path, header_row: int, idx: dict[str, int]) -> tuple[int, int]:
    i_year = index_for(idx, "سال")
    i_month = index_for(idx, "شماره ماه")
    i_cat = index_for(idx, "PH11")
    latest = (0, 0)
    for values in iter_data_rows(input_path, header_row):
        if normalize_text(safe_get(values, i_cat)) != normalize_text(CATEGORY):
            continue
        year = as_int(safe_get(values, i_year))
        month = as_int(safe_get(values, i_month))
        if year > 0 and 1 <= month <= 12 and (year, month) > latest:
            latest = (year, month)
    if latest == (0, 0):
        raise RuntimeError("No non-electric rows with a valid year/month were found")
    return latest


def process(input_path: Path, targets_path: Path) -> dict[str, Any]:
    header_row, idx, sheet_name = find_header(input_path)
    targets, by_store = load_targets(targets_path)
    period_year, period_month = find_latest_period(input_path, header_row, idx)

    i_year = index_for(idx, "سال")
    i_month = index_for(idx, "شماره ماه")
    i_day = index_for(idx, "روز", required=False)
    i_cat = index_for(idx, "PH11")
    i_store = index_for(idx, "نام فروشگاه")
    i_seller = index_for(idx, "مشاور فروش")
    i_order = index_for(idx, "شماره سفارش", required=False)

    i_amount = None
    amount_header = None
    for header in AMOUNT_HEADERS:
        i = index_for(idx, header, required=False)
        if i is not None:
            i_amount = i
            amount_header = header
            break
    if i_amount is None:
        raise RuntimeError("Missing sales amount column (مبلغ کل صحیح)")

    stats: dict[str, dict[str, Any]] = {}
    for t in targets:
        key = compact(t["name"])
        stats[key] = {
            "seller_key": key,
            "seller_name": t["name"],
            "store": t["store"],
            "sales_m": 0.0,
            "invoice_ids": set(),
            "row_count": 0,
        }

    rows_total = 0
    rows_non_electric = 0
    matched_rows = 0
    days_elapsed = 0
    unmatched_sales_m = 0.0
    unmatched_rows = 0
    unmatched: dict[tuple[str, str], float] = defaultdict(float)
    match_methods: dict[str, int] = defaultdict(int)

    for values in iter_data_rows(input_path, header_row):
        if as_int(safe_get(values, i_year)) != period_year or as_int(safe_get(values, i_month)) != period_month:
            continue
        rows_total += 1
        if normalize_text(safe_get(values, i_cat)) != normalize_text(CATEGORY):
            continue
        rows_non_electric += 1
        days_elapsed = max(days_elapsed, as_int(safe_get(values, i_day)))
        amount_m = as_float(safe_get(values, i_amount)) / RIAL_PER_MILLION_TOMAN
        store_raw = safe_get(values, i_store)
        seller_raw = safe_get(values, i_seller)
        target, _, method = match_target(by_store, store_raw, seller_raw)
        if not target:
            unmatched_rows += 1
            unmatched_sales_m += amount_m
            seller_n = normalize_text(seller_raw)
            if seller_n:
                unmatched[(normalize_text(store_raw), seller_n)] += amount_m
            continue

        key = target["_key"]
        item = stats[key]
        item["sales_m"] += amount_m
        item["row_count"] += 1
        order = safe_get(values, i_order)
        if order not in (None, ""):
            if isinstance(order, float) and order.is_integer():
                order = int(order)
            item["invoice_ids"].add(str(order))
        matched_rows += 1
        match_methods[method] += 1

    sellers = []
    matched_sellers = 0
    for t in targets:
        key = compact(t["name"])
        item = stats[key]
        if item["row_count"] > 0:
            matched_sellers += 1
        sellers.append(
            {
                "seller_key": key,
                "seller_name": item["seller_name"],
                "store": item["store"],
                "sales_m": round(item["sales_m"], 4),
                "invoice_count": len(item["invoice_ids"]),
                "row_count": item["row_count"],
            }
        )

    total_sales_m = round(sum(x["sales_m"] for x in sellers), 4)
    top_unmatched = sorted(unmatched.items(), key=lambda kv: abs(kv[1]), reverse=True)[:8]
    unmatched_summary = "; ".join(
        f"{store}/{name}:{value:.1f}M" for (store, name), value in top_unmatched
    )
    note_parts = [
        f"sheet={sheet_name}",
        f"amount={amount_header}",
        f"unmatched_rows={unmatched_rows}",
        f"unmatched_sales_m={unmatched_sales_m:.1f}",
        "match_methods=" + ",".join(f"{k}:{v}" for k, v in sorted(match_methods.items())),
    ]
    if unmatched_summary:
        note_parts.append("top_unmatched=" + unmatched_summary)

    if matched_rows == 0:
        raise RuntimeError("No campaign seller rows could be matched in the latest period")

    return {
        "period_year": period_year,
        "period_month": period_month,
        "days_elapsed": days_elapsed,
        "rows_total": rows_total,
        "rows_non_electric": rows_non_electric,
        "matched_rows": matched_rows,
        "matched_sellers": matched_sellers,
        "sales_m": total_sales_m,
        "totals": sellers,
        "note": " | ".join(note_parts)[:3500],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--targets", type=Path, default=Path(__file__).with_name("targets.json"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        result = process(args.input, args.targets)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "ok": True,
                    "period": f"{result['period_year']}/{result['period_month']}",
                    "days_elapsed": result["days_elapsed"],
                    "matched_sellers": result["matched_sellers"],
                    "sales_m": result["sales_m"],
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
