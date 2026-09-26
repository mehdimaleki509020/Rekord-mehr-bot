#!/usr/bin/env python3
"""Process raw SalesReport .xlsb for the Rekord Mehr Bale bot.

For Mehr 1405, aggregates each campaign seller's Mehr sales through the latest
available Mehr day N and the same comparison window (Shahrivar 1..N).
Seller matching is deterministic: Persian normalization, compact matching,
token-order matching, and duplicate-name collapse. No fuzzy matching is used.
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
from typing import Any

from pyxlsb import open_workbook

CATEGORY = "خانگی غیر برقی"
RIAL_PER_MILLION_TOMAN = 10_000_000.0
REQUIRED_HEADERS = {"مشاور فروش", "نام فروشگاه", "PH11", "شماره ماه", "سال"}
AMOUNT_HEADERS = ("مبلغ کل صحیح", "خالص+کارمزد صحیح")


def normalize_text(value: Any) -> str:
    s = "" if value is None else str(value)
    s = unicodedata.normalize("NFKC", s)
    table = str.maketrans({
        "ي":"ی","ى":"ی","ك":"ک","ۀ":"ه","ة":"ه","ؤ":"و",
        "إ":"ا","أ":"ا","ٱ":"ا","آ":"ا","ئ":"ی","ـ":" ",
    })
    s = s.translate(table).replace("\u200c"," ").replace("\u200f"," ").replace("\u200e"," ")
    s = "".join(ch for ch in s if unicodedata.category(ch) not in {"Mn","Cf"})
    s = re.sub(r"[^0-9A-Za-z\u0600-\u06FF]+", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def _collapse_full_repetition(s: str) -> str:
    tokens = s.split()
    for size in range(1, len(tokens)//2 + 1):
        if len(tokens) % size:
            continue
        block = tokens[:size]
        if all(tokens[i] == block[i % size] for i in range(len(tokens))):
            return " ".join(block)
    return s


def compact(value: Any) -> str:
    return re.sub(r"[^0-9A-Za-z\u0600-\u06FF]", "", _collapse_full_repetition(normalize_text(value)))


def token_signature(value: Any) -> str:
    return "|".join(sorted(_collapse_full_repetition(normalize_text(value)).split()))


def as_int(value: Any) -> int:
    if value is None or value == "": return 0
    try: return int(float(value))
    except (TypeError, ValueError):
        m = re.search(r"-?\d+", normalize_text(value))
        return int(m.group()) if m else 0


def as_float(value: Any) -> float:
    if value is None or value == "": return 0.0
    try:
        v = float(value); return v if math.isfinite(v) else 0.0
    except (TypeError, ValueError):
        try: return float(str(value).replace(",", "").strip())
        except ValueError: return 0.0


def row_values(row): return [cell.v for cell in row]


def find_header(input_path: Path):
    with open_workbook(str(input_path)) as wb:
        if not wb.sheets: raise RuntimeError("Workbook has no sheets")
        sheet_name = wb.sheets[0]
        with wb.get_sheet(1) as sh:
            for row_number, row in enumerate(sh.rows(), start=1):
                values = row_values(row)
                normalized = [normalize_text(v) for v in values]
                original = [str(v).strip() if v is not None else "" for v in values]
                idx_norm = {name:i for i,name in enumerate(normalized) if name}
                if {normalize_text(x) for x in REQUIRED_HEADERS}.issubset(idx_norm):
                    idx = {}
                    for i,name in enumerate(original):
                        if name: idx[name] = i
                    for i,name in enumerate(normalized):
                        if name: idx[name] = i
                    return row_number, idx, sheet_name
                if row_number >= 30: break
    raise RuntimeError("Could not find the SalesReport header row")


def index_for(idx, name, required=True):
    if name in idx: return idx[name]
    n = normalize_text(name)
    if n in idx: return idx[n]
    if required: raise RuntimeError(f"Missing required column: {name}")
    return None


def iter_data_rows(input_path: Path, header_row: int):
    with open_workbook(str(input_path)) as wb:
        with wb.get_sheet(1) as sh:
            for row_number,row in enumerate(sh.rows(), start=1):
                if row_number > header_row: yield row_values(row)


def safe_get(values, i):
    return None if i is None or i < 0 or i >= len(values) else values[i]


def load_targets(path: Path):
    targets = json.loads(path.read_text(encoding="utf-8"))
    if len(targets) != 92: raise RuntimeError(f"Expected 92 campaign sellers, got {len(targets)}")
    by_store = defaultdict(list); expanded=[]
    for t in targets:
        if isinstance(t, list):
            if len(t) != 6: raise RuntimeError("Compact target row must have 6 fields")
            store,name,baseline_m,t1,t2,t3=t
            t={"store":store,"name":name,"baseline_m":baseline_m,"target20_m":t1,"target30_m":t2,"target40_m":t3}
        expanded.append(t)
        item=dict(t); item["_store"]=compact(item["store"]); item["_name"]=compact(item["name"]); item["_tok"]=token_signature(item["name"]); item["_key"]=compact(item["name"])
        by_store[item["_store"]].append(item)
    return expanded, by_store


def match_target(by_store, store: Any, seller: Any):
    candidates=by_store.get(compact(store),[])
    name_key=compact(seller); tok=token_signature(seller)
    if not candidates or not name_key: return None,0.0,"none"
    hits=[t for t in candidates if name_key==t["_name"]]
    if len(hits)==1: return hits[0],1.0,"compact"
    hits=[t for t in candidates if tok and tok==t["_tok"]]
    if len(hits)==1: return hits[0],0.995,"tokens"
    hits=[]
    for t in candidates:
        c=t["_name"]
        if c and (name_key==c+c or (len(name_key)>=len(c)*1.8 and name_key.replace(c,"")=="")): hits.append(t)
    if len(hits)==1: return hits[0],0.99,"duplicate"
    return None,0.0,"ambiguous" if hits else "none"


def process(input_path: Path, targets_path: Path):
    header_row,idx,sheet_name=find_header(input_path)
    targets,by_store=load_targets(targets_path)

    iy=index_for(idx,"سال"); im=index_for(idx,"شماره ماه"); iday=index_for(idx,"روز",required=False); ic=index_for(idx,"PH11")
    istore=index_for(idx,"نام فروشگاه"); iseller=index_for(idx,"مشاور فروش"); iorder=index_for(idx,"شماره سفارش",required=False)
    iamount=amount_header=None
    for h in AMOUNT_HEADERS:
        i=index_for(idx,h,required=False)
        if i is not None: iamount,amount_header=i,h; break
    if iamount is None: raise RuntimeError("Missing sales amount column (مبلغ کل صحیح)")

    records=[]
    unmatched_all=defaultdict(float)
    latest=(0,0)
    for v in iter_data_rows(input_path,header_row):
        if normalize_text(safe_get(v,ic))!=normalize_text(CATEGORY): continue
        y,m,d=as_int(safe_get(v,iy)),as_int(safe_get(v,im)),as_int(safe_get(v,iday))
        if y<=0 or not (1<=m<=12): continue
        if (y,m)>latest: latest=(y,m)
        amount_m=as_float(safe_get(v,iamount))/RIAL_PER_MILLION_TOMAN
        target,_,method=match_target(by_store,safe_get(v,istore),safe_get(v,iseller))
        if target:
            order=safe_get(v,iorder)
            if isinstance(order,float) and order.is_integer(): order=int(order)
            records.append((y,m,d,target["_key"],amount_m,None if order in (None,"") else str(order),method))
        else:
            sn=normalize_text(safe_get(v,iseller))
            if sn: unmatched_all[(y,m,normalize_text(safe_get(v,istore)),sn)]+=amount_m

    if latest==(0,0): raise RuntimeError("No non-electric rows with a valid year/month were found")
    period_year,period_month=latest
    days_elapsed=max((d for y,m,d,*_ in records if (y,m)==latest), default=0)
    comp_year,comp_month=period_year,period_month-1
    if comp_month==0: comp_year,comp_month=period_year-1,12

    stats={}
    for t in targets:
        k=compact(t["name"])
        stats[k]={"seller_name":t["name"],"store":t["store"],"sales_m":0.0,"comparison_m":0.0,"invoice_ids":set(),"row_count":0}

    rows_non_electric=matched_rows=0; methods=defaultdict(int)
    for y,m,d,k,amount_m,order,method in records:
        if not (1<=d<=days_elapsed): continue
        item=stats[k]
        if (y,m)==(period_year,period_month):
            rows_non_electric+=1; matched_rows+=1; methods[method]+=1
            item["sales_m"]+=amount_m; item["row_count"]+=1
            if order is not None: item["invoice_ids"].add(order)
        elif (y,m)==(comp_year,comp_month):
            item["comparison_m"]+=amount_m

    unmatched_rows=0; unmatched_sales_m=0.0; unmatched=defaultdict(float)
    for (y,m,store,name),value in unmatched_all.items():
        if (y,m)==(period_year,period_month):
            unmatched_rows+=1; unmatched_sales_m+=value; unmatched[(store,name)]+=value

    sellers=[]; matched_sellers=0
    for t in targets:
        item=stats[compact(t["name"])]
        if item["row_count"]>0: matched_sellers+=1
        sellers.append({
            "seller_name":item["seller_name"],"store":item["store"],
            "sales_m":round(item["sales_m"],4),"comparison_m":round(item["comparison_m"],4),
            "invoice_count":len(item["invoice_ids"]),"row_count":item["row_count"],
        })
    if matched_rows==0: raise RuntimeError("No campaign seller rows could be matched in the latest period")
    total_sales_m=round(sum(x["sales_m"] for x in sellers),4)
    comp_sales_m=round(sum(x["comparison_m"] for x in sellers),4)
    top=sorted(unmatched.items(),key=lambda kv:abs(kv[1]),reverse=True)[:8]
    note=[f"sheet={sheet_name}",f"amount={amount_header}",f"comparison={comp_year}/{comp_month}:1-{days_elapsed}",f"comparison_sales_m={comp_sales_m:.1f}",f"unmatched_groups={unmatched_rows}",f"unmatched_sales_m={unmatched_sales_m:.1f}","match_methods="+",".join(f"{k}:{v}" for k,v in sorted(methods.items()))]
    if top: note.append("top_unmatched="+"; ".join(f"{st}/{n}:{v:.1f}M" for (st,n),v in top))
    return {"period_year":period_year,"period_month":period_month,"days_elapsed":days_elapsed,"comparison_year":comp_year,"comparison_month":comp_month,"rows_total":rows_non_electric,"rows_non_electric":rows_non_electric,"matched_rows":matched_rows,"matched_sellers":matched_sellers,"sales_m":total_sales_m,"comparison_sales_m":comp_sales_m,"totals":sellers,"note":" | ".join(note)[:3500]}


def main():
    p=argparse.ArgumentParser(); p.add_argument("input",type=Path); p.add_argument("--targets",type=Path,default=Path(__file__).with_name("targets.json")); p.add_argument("--output",type=Path,required=True); a=p.parse_args()
    try:
        r=process(a.input,a.targets); a.output.write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding="utf-8")
        print(json.dumps({"ok":True,"period":f"{r['period_year']}/{r['period_month']}","days_elapsed":r["days_elapsed"],"matched_sellers":r["matched_sellers"],"sales_m":r["sales_m"],"comparison_sales_m":r["comparison_sales_m"]},ensure_ascii=False)); return 0
    except Exception as exc:
        print(f"ERROR: {exc}",file=sys.stderr); return 1

if __name__=="__main__": raise SystemExit(main())
