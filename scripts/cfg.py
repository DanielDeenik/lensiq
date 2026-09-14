#!/usr/bin/env python3
"""Push or read an app_config key through the token gated console admin route.
Usage: cfg.py set <key> <file>   |   cfg.py setval <key> <value>
No values are hardcoded: the endpoint and token come from the environment."""
import json, os, sys, urllib.request

BASE = os.environ["CONSOLE_BASE"].rstrip("/")
TOKEN = os.environ["CONSOLE_TOKEN"]

def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 method="POST",
                                 headers={"Content-Type": "application/json",
                                          "x-console-token": TOKEN})
    return urllib.request.urlopen(req, timeout=120).read().decode()

def get(path):
    req = urllib.request.Request(BASE + path, headers={"x-console-token": TOKEN})
    return urllib.request.urlopen(req, timeout=180).read().decode()

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "set":
        print(post("/api/config", {"key": sys.argv[2], "value": open(sys.argv[3]).read()}))
    elif cmd == "setval":
        print(post("/api/config", {"key": sys.argv[2], "value": sys.argv[3]}))
    elif cmd == "get":
        print(get(sys.argv[2]))
    else:
        sys.exit("unknown command")
