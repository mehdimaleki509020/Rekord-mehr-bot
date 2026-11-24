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
        if (result.get("isolated_preview") and result.get("test_bot_token_present") and
            result.get("expected_bot_username_present") and result.get("test_password_present")):
            print("::notice::Fresh Bale Preview inherited all expected secure bindings")
            break
    except Exception as exc:
        print("Fresh Preview deployment not ready:",type(exc).__name__)
    time.sleep(7)
else:
    sys.exit("::error::Fresh Bale Preview did not receive test bot bindings")
