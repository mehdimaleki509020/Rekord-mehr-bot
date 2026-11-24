#!/usr/bin/env python3
"""Confirm new Bale Preview has fresh Base secrets. No secret values are read."""
import json
import sys
import time
import urllib.error
import urllib.request

BASE="https://feature-hooshi-coach-bale-new-preview-rekord-mehr-bot.mehdimaleki509020.workers.dev"
for attempt in range(30):
    try:
        req=urllib.request.Request(BASE+"/coach-bale-test-ready",headers={"User-Agent":"CoachPilotReadiness/1.0"})
        with urllib.request.urlopen(req,timeout=12) as response:
            result=json.load(response)
        print("Fresh Bale Preview readiness (public booleans only):",json.dumps(result,ensure_ascii=False))
        if result.get("sales_snapshot_ready") is False:
            print("::warning::Fresh Preview currently lacks imported 172/542 sales snapshot")
        if (result.get("isolated_preview") and result.get("test_bot_token_present") and
            result.get("expected_bot_username_present") and result.get("test_password_present")):
            print("::notice::Fresh Bale Preview inherited all expected secure bindings")
            break
    except Exception as exc:
        print("Fresh Preview deployment not ready:",type(exc).__name__)
    time.sleep(7)
else:
    sys.exit("::error::Fresh Bale Preview did not receive test bot bindings")

# Read-only live webhook check. Does not expose credentials or callback URL.
try:
    req=urllib.request.Request(BASE+"/coach-bale-test-connection",headers={"User-Agent":"CoachPilotReadiness/1.0"})
    with urllib.request.urlopen(req,timeout=20) as response:
        connection=json.load(response)
    print("Bale webhook live status (no secrets):",json.dumps(connection,ensure_ascii=False))
    if not connection.get("webhook_connected"):
        print("::warning::User may need to recheck Bale test setup before first message")
except Exception as exc:
    print("::warning::Could not independently confirm Bale webhook: "+type(exc).__name__)

# Verify knowledge UI only after Cloudflare's latest branch build has deployed.
# PR checks can start before the new preview release is ready.
for attempt in range(30):
    try:
        req=urllib.request.Request(BASE+"/coach-kb-panel",
            headers={"User-Agent":"CoachPilotReadiness/1.0"})
        with urllib.request.urlopen(req,timeout=15) as res:
            content=res.read(40000).decode("utf-8")
        if "بانک دانش اختصاصی مربی" in content and "coach-kb-api/rules" in content:
            break
    except (urllib.error.URLError,TimeoutError):
        pass
    time.sleep(7)
else:
    sys.exit("::error::Latest knowledge management panel not deployed to Preview")
try:
    urllib.request.urlopen(urllib.request.Request(BASE+"/coach-kb-api/rules",headers={"User-Agent":"CoachPilotReadiness/1.0"}),timeout=15)
    sys.exit("::error::Knowledge API allowed unauthenticated access")
except urllib.error.HTTPError as err:
    if err.code not in (401,403):
        sys.exit("::error::Knowledge API unexpected anonymous status "+str(err.code))
print("::notice::Preview knowledge panel available; anonymous knowledge API denied")
