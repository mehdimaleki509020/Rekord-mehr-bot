#!/usr/bin/env python3
"""Process isolated Bale Preview queue. The runner is ephemeral; no files/artifacts/logged row data."""
import hashlib
import json
import os
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path
from processor_ops import parse, ReportError

BASE="https://feature-hooshi-coach-bale-new-preview-rekord-mehr-bot.mehdimaleki509020.workers.dev"
AUDIENCE="rekord-mehr-coach-ops-preview"
BRANCH="refs/heads/feature/hooshi-coach-bale-new-preview"
MAX_FILE=20*1024*1024
_token=None
_token_time=0

def token():
    global _token,_token_time
    if _token and time.monotonic()-_token_time<160:return _token
    url=os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]+"&audience="+AUDIENCE
    req=urllib.request.Request(url,headers={"Authorization":"Bearer "+os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
    with urllib.request.urlopen(req,timeout=15) as res:
        _token=json.load(res)["value"]
    _token_time=time.monotonic()
    return _token

def request(path,method="POST",data=None,lease=None,raw=False):
    headers={"Authorization":"Bearer "+token(),"User-Agent":"CoachOpsPreview/1.0"}
    if lease:headers["x-coach-ops-lease"]=lease
    if data is not None:
        data=json.dumps(data,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode("utf-8")
        headers["Content-Type"]="application/json"
    req=urllib.request.Request(BASE+"/coach-ops-processor/"+path,data=data,method=method,headers=headers)
    with urllib.request.urlopen(req,timeout=60) as res:
        if raw:
            value=res.read(MAX_FILE+1)
            if not value or len(value)>MAX_FILE:raise ReportError("too_large")
            return value
        reply=json.load(res)
        if not reply.get("ok"):raise RuntimeError("invalid_reply")
        return reply

def process(job):
    job_id=int(job["id"]);lease=job["lease"];root="jobs/"+str(job_id)+"/"
    try:
        filename=Path(job["file_name"])
        suffix=filename.suffix.lower()
        if suffix not in (".xlsb",".xlsx",".csv"):raise ReportError("unsupported_layout")
        if not 0<int(job["file_size"])<=MAX_FILE:raise ReportError("too_large")
        raw=request(root+"file","GET",lease=lease,raw=True)
        digest=hashlib.sha256(raw).hexdigest()
        with tempfile.TemporaryDirectory(prefix="coach-ops-") as directory:
            path=Path(directory)/("report"+suffix)
            path.write_bytes(raw)
            del raw
            kind,rows=parse(path)
        meta=request(root+"begin",data={"kind":kind,"hash":digest,"count":len(rows)},lease=lease)
        if meta.get("duplicate"):
            print("Duplicate report skipped")
            return
        for i in range(0,len(rows),80):
            request(root+"batch",data={"rows":rows[i:i+80]},lease=lease)
        done=request(root+"finish",data={},lease=lease)
        print("Validated operational report")
    except Exception as exc:
        if isinstance(exc,ReportError) and str(exc) in {"unsupported_layout","ambiguous_layout","invalid_data","too_large","empty_data","parse_error"}:
            reason=str(exc)
        elif isinstance(exc,(ValueError,UnicodeError)):reason="parse_error"
        else:reason="processor_error"
        # Never log exception strings, file contents, names, token, paths or HTTP body.
        print("Operational report requires attention")
        try:request(root+"fail",data={"reason":reason},lease=lease)
        except Exception:print("Could not record report failure; lease will expire")
        
def main():
    if os.environ.get("GITHUB_REF")!=BRANCH or os.environ.get("GITHUB_EVENT_NAME")!="workflow_dispatch":
        raise SystemExit("Refused non-preview invocation")
    deadline=time.monotonic()+14*60
    while time.monotonic()<deadline:
        job=request("pending",data={}).get("job")
        if not job:
            print("Preview queue empty")
            return
        process(job)
    print("Time limit reached; remaining jobs stay in queue")
if __name__=="__main__":main()
