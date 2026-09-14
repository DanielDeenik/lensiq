#!/usr/bin/env python3
"""Inject config/skill-profile.json into src/site.master.html between the
PROFILE_START and PROFILE_END markers. One source, two consumers: the page
scores a pasted spec with it, and the agent is handed the same file.

  python3 scripts/embed_profile.py          write the master
  python3 scripts/embed_profile.py --check  fail if the master is stale
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILE = ROOT / "config" / "skill-profile.json"
MASTER = ROOT / "src" / "site.master.html"
PATTERN = re.compile(r"(/\*PROFILE_START\*/)(.*?)(/\*PROFILE_END\*/)", re.S)


def main() -> None:
    profile = json.loads(PROFILE.read_text())
    for key in ("tiers", "areas", "groups", "verdicts"):
        if key not in profile:
            sys.exit("EMBED FAILED: skill-profile.json is missing '%s'" % key)
    for area in profile["areas"]:
        if area["tier"] not in profile["tiers"]:
            sys.exit("EMBED FAILED: area %s has unknown tier %s" % (area["id"], area["tier"]))
        if not area.get("terms"):
            sys.exit("EMBED FAILED: area %s has no terms" % area["id"])
        if not area.get("line"):
            sys.exit("EMBED FAILED: area %s has no honest line to show a recruiter" % area["id"])

    compact = json.dumps(profile, separators=(",", ":"))
    master = MASTER.read_text()
    if len(PATTERN.findall(master)) != 1:
        sys.exit("EMBED FAILED: expected exactly one PROFILE_START/PROFILE_END pair in the master")
    updated = PATTERN.sub(lambda m: m.group(1) + compact + m.group(3), master, count=1)

    if "--check" in sys.argv:
        if updated != master:
            sys.exit("CHECK FAILED: the skill profile in src/site.master.html is stale, run scripts/embed_profile.py")
        print("skill profile is embedded and current (%d areas, %d bytes)"
              % (len(profile["areas"]), len(compact)))
        return

    MASTER.write_text(updated)
    print("embedded skill profile into %s (%d areas, %d bytes)"
          % (MASTER, len(profile["areas"]), len(compact)))


if __name__ == "__main__":
    main()
