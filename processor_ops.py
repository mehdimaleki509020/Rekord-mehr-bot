#!/usr/bin/env python3
"""Preview-only ingestion. Read raw files in ephemeral runner; never log row contents."""
from __future__ import annotations
import csv
import hashlib
import math
import re
import zipfile
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from processor_aban import normalize, compact, name_signature

GROUPS={
    "پخت و پز":"cookware","پذیرایی و سرو":"tableware",
    "کالای شیشه ای و کریستال":"glassware","ظروف آشپزخانه":"kitchenware",
    "لوازم حمام و نظافت":"bath_cleaning","ابزار آشپزی":"kitchen_tools",
    "سفری":"travel","کالای سفری":"travel",
    "ظرف نگهداری و ذخیره سازی":"storage","ظروف نگهداری و ذخیره سازی":"storage",
    "ظروف یکبار مصرف":"disposables","ظروف یک بار مصرف":"disposables",
}
GROUPS={normalize(k):v for k,v in GROUPS.items()}
DIGITS=str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩","01234567890123456789")
class ReportError(Exception):
    pass

def string(v):
    return "" if v is None else str(v).strip()

def number(v):
    try:
        if isinstance(v,bool) or v is None: raise ValueError()
        x=float(str(v).translate(DIGITS).replace(",","").replace("٬",""))
        if not math.isfinite(x): raise ValueError()
        return x
    except (TypeError,ValueError):
        raise ReportError("invalid_data") from None

def integer(v):
    n=number(v)
    if not n.is_integer(): raise ReportError("invalid_data")
    return int(n)

def date(y,m,d):
    y,m,d=integer(y),integer(m),integer(d)
    if not 1300<=y<=1499 or not 1<=m<=12 or not 1<=d<=(31 if m<=6 else 30):
        raise ReportError("invalid_data")
    return f"{y:04}-{m:02}-{d:02}"

def parse_date(v):
    m=re.fullmatch(r"(1[34]\d{2})[-/](\d{1,2})[-/](\d{1,2})",string(v).translate(DIGITS))
    if not m: raise ReportError("invalid_data")
    return date(*m.groups())

def parse_period(v):
    m=re.fullmatch(r"(1[34]\d{2})[-/](\d{1,2})",string(v).translate(DIGITS))
    if not m: raise ReportError("invalid_data")
    return date(*m.groups(),1)[:7]

def norm_headers(values):
    return [normalize(x) for x in values]

SALES={"نام فروشگاه","مشاور فروش","PH11","PH21","سال","شماره ماه","روز","مبلغ کل صحیح"}
# Strict flat formats. Never guess units or interpret generic "traffic"/"stock" as a daily number.
# Native inventory/traffic/plan layouts require sample-specific adapters.
LAYOUTS={
 "sales":SALES,
 "inventory":{"نام فروشگاه","کد کالا","نام کالا","گروه کالا","تاریخ گزارش","موجودی تعدادی"},
 "traffic":{"نام فروشگاه","تاریخ گزارش","پاخور روزانه"},
 "plan":{"نام فروشگاه","ماه شمسی","پلن غیربرقی (میلیون تومان)"},
}
LAYOUTS={k:{normalize(s) for s in v} for k,v in LAYOUTS.items()}

def detect(headers):
    names=set(norm_headers(headers))
    matched=[k for k,v in LAYOUTS.items() if v.issubset(names)]
    if len(matched)>1: raise ReportError("ambiguous_layout")
    return matched[0] if matched else None

@contextmanager
def workbook(path):
    suffix=path.suffix.lower()
    if suffix==".csv":
        with path.open(encoding="utf-8-sig",newline="") as f:
            yield [("CSV",csv.reader(f))]
        return
    if suffix not in (".xlsb",".xlsx"): raise ReportError("unsupported_layout")
    try:
        with zipfile.ZipFile(path) as z:
            if sum(x.file_size for x in z.infolist())>180*1024*1024:
                raise ReportError("too_large")
    except zipfile.BadZipFile:
        raise ReportError("parse_error") from None
    if suffix==".xlsb":
        from pyxlsb import open_workbook
        with open_workbook(str(path)) as b:
            def sheets():
                for name in b.sheets:
                    with b.get_sheet(name) as sheet:
                        yield name,([c.v for c in row] for row in sheet.rows())
            yield sheets()
    else:
        from openpyxl import load_workbook
        b=load_workbook(path,read_only=True,data_only=True,keep_links=False)
        try:yield ((s.title,s.iter_rows(values_only=True)) for s in b.worksheets)
        finally:b.close()

def records(path):
    found=None
    # Scan candidate headers before parsing; do not combine independent sheets.
    with workbook(path) as sheets:
        for name,rows in sheets:
            for ix,values in enumerate(rows):
                if ix>=30:break
                kind=detect(values)
                if kind:
                    if found:raise ReportError("ambiguous_layout")
                    names=norm_headers(values)
                    required=LAYOUTS[kind]
                    if any(names.count(x)!=1 for x in required):
                        raise ReportError("ambiguous_layout")
                    found=(name,ix,kind,names)
                    break
    if not found:raise ReportError("unsupported_layout")
    name,start,kind,headers=found
    with workbook(path) as sheets:
        for sheet,rows in sheets:
            if sheet!=name:continue
            for ix,values in enumerate(rows):
                if ix<=start:continue
                if ix>500000:raise ReportError("too_large")
                yield kind,{k:values[j] if j<len(values) else None for j,k in enumerate(headers) if k}
            return

def get(row,key):
    return row.get(normalize(key))

def safe_text(v,n=160):
    return re.sub(r"[\x00-\x1f\x7f]"," ",string(v))[:n]

def record(kind,store,period,start,end,value,group="all",seller="",sku="",label=""):
    return dict(kind=kind,store_key=store,seller_key=seller,group_code=group,sku=sku,
                period=period,date_from=start,date_to=end,value=round(value,5),label=label)

def parse(path):
    sales=defaultdict(float)
    identities={}
    ranges={}
    flat={}
    kind=None
    for kind,row in records(path):
        if kind=="sales" and normalize(get(row,"PH11"))!=normalize("خانگی غیر برقی"):
            continue
        if kind!="sales" and not any(string(v) for v in row.values()):continue
        store=compact(get(row,"نام فروشگاه"))
        if not store or len(store)>100:
            raise ReportError("invalid_data")
        if kind=="sales":
            day=date(get(row,"سال"),get(row,"شماره ماه"),get(row,"روز"))
            period=day[:7]
            amount=number(get(row,"مبلغ کل صحیح"))/10_000_000
            group=GROUPS.get(normalize(get(row,"PH21")),"other")
            # One snapshot per store/month; observed dates, not a guessed report cutoff.
            bounds=ranges.setdefault((store,period),[day,day])
            bounds[0]=min(bounds[0],day);bounds[1]=max(bounds[1],day)
            sales[(store,"",group,period)]+=amount
            seller=string(get(row,"مشاور فروش"))
            if seller:
                signature=name_signature(seller)
                name=compact(seller)
                if not name or len(store)+len(name)+1>180:raise ReportError("invalid_data")
                # Exact key only at retrieval; no fuzzy match to another person.
                old=identities.get((store,signature))
                if not old or day>=old[0]:identities[(store,signature)]=(day,name)
                sales[(store,signature,group,period)]+=amount
        else:
            if kind=="plan":
                period=parse_period(get(row,"ماه شمسی"))
                start=period+"-01"
                end=period+("-31" if int(period[-2:])<=6 else "-30")
                # Plan applies to month, not a specific day. Do not infer Esfand end.
                if period.endswith("-12"):end=start
                value=number(get(row,"پلن غیربرقی (میلیون تومان)"))
                rec=record(kind,store,period,start,end,value)
            else:
                day=parse_date(get(row,"تاریخ گزارش"))
                if kind=="traffic":
                    rec=record(kind,store,day[:7],day,day,integer(get(row,"پاخور روزانه")))
                else:
                    sku=safe_text(get(row,"کد کالا"),180)
                    if not sku:raise ReportError("invalid_data")
                    group=GROUPS.get(normalize(get(row,"گروه کالا")))
                    if not group:raise ReportError("unsupported_layout")
                    rec=record(kind,store,day[:7],day,day,integer(get(row,"موجودی تعدادی")),group=group,
                               sku=sku,label=safe_text(get(row,"نام کالا")))
            if rec["value"]<0:raise ReportError("invalid_data")
            k=tuple(rec[x] for x in ("store_key","sku","period","date_from","date_to"))
            # Exact duplicate row safe; contradictory duplicates cannot be assumed additive.
            if k in flat and flat[k]!=rec:raise ReportError("invalid_data")
            flat[k]=rec
    if kind=="sales":
        result=[]
        for (store,signature,group,period),value in sales.items():
            seller=store+":"+identities[(store,signature)][1] if signature else ""
            result.append(record(kind,store,period,*ranges[(store,period)],value,group=group,seller=seller))
    else:result=list(flat.values())
    if not result:raise ReportError("empty_data")
    if len(result)>80000:raise ReportError("too_large")
    return kind,result
