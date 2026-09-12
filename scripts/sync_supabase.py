#!/usr/bin/env python3
"""Publish the built site into Supabase app_config.page_html.

The edge function "site" serves this column, so the hosted assistant and the
static site always render the same HTML. Runs in CI after the build passes.

Environment:
  SUPABASE_URL           https://<ref>.supabase.co
  SUPABASE_SERVICE_KEY   service_role key (repository secret, never committed)

Verifies by reading the row back and comparing md5 before reporting success.
"""
import hashlib
import json
import os
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not URL or not KEY:
    print("SKIP: SUPABASE_URL / SUPABASE_SERVICE_KEY not set, nothing to publish")
    raise SystemExit(0)

html = (ROOT / "index.html").read_text()
want = hashlib.md5(html.encode()).hexdigest()


def call(method, path, body=None):
    req = urllib.request.Request(
        URL + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": KEY,
            "Authorization": "Bearer " + KEY,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else []


call("PATCH", "/rest/v1/app_config?key=eq.page_html", {"value": html})
rows = call("GET", "/rest/v1/app_config?key=eq.page_html&select=value")
if not rows:
    sys.exit("SYNC FAILED: page_html row not found after write")
got = hashlib.md5(rows[0]["value"].encode()).hexdigest()
if got != want:
    sys.exit("SYNC FAILED: md5 mismatch, wrote %s but read back %s" % (want, got))
print("Supabase page_html synced (%d bytes, md5 %s)" % (len(html), want))
