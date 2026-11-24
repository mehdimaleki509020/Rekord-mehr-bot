"""Safely probe Cloudflare preview and run one fictional-seller Hooshi test with GitHub OIDC.

This job never prints or stores the OIDC token. No real seller data is transmitted.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://feature-hooshi-coach-pilot-rekord-mehr-bot.mehdimaleki509020.workers.dev"
AUD = "rekord-mehr-bot-coach-preview"

def call(url, *, method="GET", headers=None, data=None):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            result = json.load(exc)
        except (ValueError, OSError):
            result = {"error": "invalid_json"}
        return exc.code, result

# The Cloudflare PR deployment is asynchronous. Wait for the new diagnostics route.
ready = None
for attempt in range(24):
    try:
        code, result = call(BASE + "/coach-preview-ready")
        if code == 200 and result.get("preview") is True:
            ready = result
            break
        print(f"Preview probe {attempt + 1}: status={code} (deployment pending)", flush=True)
    except Exception as exc:
        print(f"Preview probe {attempt + 1}: connection not ready ({type(exc).__name__})", flush=True)
    time.sleep(10)

if ready is None:
    sys.exit("::error::Preview diagnostics did not become available. Check Cloudflare deployment and previews.vars.")
print("Preview readiness (values only, no secrets):", json.dumps(ready, ensure_ascii=False))
if not ready.get("coach_enabled"):
    sys.exit("::error::COACH_ENABLED is disabled in deployed preview")
if not ready.get("hooshi_key_present"):
    sys.exit("::error::HOOSHI_API_KEY is not bound to this Cloudflare preview deployment")
if not ready.get("test_token_present"):
    print("::warning::COACH_TEST_TOKEN is not bound to this Cloudflare preview deployment")

# GitHub OIDC obtains a short-lived signed credential (distinct from all app secrets).
request_url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
separator = "&" if "?" in request_url else "?"
request_url += separator + urllib.parse.urlencode({"audience": AUD})
req = urllib.request.Request(request_url, headers={
    "Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
})
with urllib.request.urlopen(req, timeout=15) as response:
    oidc = json.load(response)["value"]

# Print only non-secret identity claims to aid debugging if the issuer changes.
segment = oidc.split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
print("OIDC claims:", json.dumps({
    "ref": claims.get("ref"),
    "event_name": claims.get("event_name"),
    "workflow_ref": claims.get("workflow_ref"),
    "repository_id": claims.get("repository_id"),
    "actor_id": claims.get("actor_id")
}, ensure_ascii=False))

code, result = call(BASE + "/coach-ci-smoke", method="POST",
                    headers={"Authorization": "Bearer " + oidc}, data=b"{}")
print("Live Hooshi smoke HTTP:", code)
if not result.get("ok"):
    sys.exit("::error::Hooshi test failed: " + str(result.get("error", "unknown")))
answer = str(result.get("answer", ""))
print("Hooshi response (fictional seller only):", answer[:1500])
if not answer.strip():
    sys.exit("::error::Hooshi returned an empty response")
ascii_digits = answer.translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))
if "500" not in ascii_digits or "50" not in ascii_digits:
    print("::warning::Review target/difference reasoning: expected 500 million target and 50 million gap")
print("::notice::Live provider connection succeeded using fictional seller only")
