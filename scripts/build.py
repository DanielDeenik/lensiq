#!/usr/bin/env python3
"""Build the public site from source.

src/site.master.html  the single source of truth for markup, styles and charts.
                      First line is the artifact title and is stripped.
src/head.html         SEO head, wraps the body for the hosted variant.
src/ask.js            API-backed Q&A + LinkedIn share, replaces the offline FACTS block.

Output: index.html at the repo root, served by Cloudflare Pages and GitHub Pages.

Deterministic: same inputs always produce the same bytes. The build fails loudly
if any anchor it depends on is missing or ambiguous, so a silent half-transform
can never reach production.
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

FREEFORM_OFFLINE = '''<div class="freeform" id="freeform" hidden>
      <div class="row">
        <input id="qinput" type="text" placeholder="e.g. Is Dan a fit for a SimCorp Front Office lead role?" maxlength="300">
        <button id="qbtn" type="button">Ask</button>
      </div>
      <p class="note">Answers come only from Dan's published profile. Rates, client project internals and personal data are not discussed here; those questions go to Dan directly.</p>'''

FREEFORM_HOSTED = '''<div class="freeform" id="freeform">
      <div class="row">
        <input id="qinput" type="text" placeholder="e.g. Is Dan a fit for a SimCorp Front Office lead role?" maxlength="300">
        <button id="qbtn" type="button">Ask</button>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="qemail" type="email" placeholder="Your email (optional, for a reply if the assistant is offline)" maxlength="200">
      </div>
      <p class="note">Answers come only from Dan's published profile. Rates, client project internals and personal data are not discussed here; those questions go to Dan directly. If the assistant is offline, your question is logged and answered by email within one business day when you leave an address.</p>'''

FOOTER_OFFLINE = "no client-confidential information and no commercial terms.</span>"
FOOTER_HOSTED = (
    "no client-confidential information and no commercial terms. It stores only the "
    "questions asked, and an email address only when you choose to leave one for a reply.</span>"
)


def require_once(haystack, needle, label):
    n = haystack.count(needle)
    if n != 1:
        sys.exit("BUILD FAILED: anchor %r found %d times, expected exactly 1" % (label, n))


def build():
    master = (SRC / "site.master.html").read_text()
    head = (SRC / "head.html").read_text()
    ask = (SRC / "ask.js").read_text()

    body = "\n".join(master.split("\n")[1:])  # drop the artifact title line

    require_once(body, FREEFORM_OFFLINE, "freeform block")
    body = body.replace(FREEFORM_OFFLINE, FREEFORM_HOSTED)

    require_once(body, FOOTER_OFFLINE, "footer privacy sentence")
    body = body.replace(FOOTER_OFFLINE, FOOTER_HOSTED)

    marker = "\nconst FACTS = "
    require_once(body, marker, "FACTS block")
    start = body.index(marker)
    end = body.index("</script>", start)
    body = body[:start] + "\n" + ask + "\n" + body[end:]

    out = head + body + "\n</body>\n</html>"

    for must in ('id="analytics"', 'id="anapanel"', 'id="sankey"', 'id="fit"', 'id="qemail"'):
        if must not in out:
            sys.exit("BUILD FAILED: expected %s in output" % must)
    if "const FACTS" in out:
        sys.exit("BUILD FAILED: offline FACTS block leaked into the hosted build")
    if out.index('<section id="analytics">') > out.index('<section id="fit">'):
        sys.exit("BUILD FAILED: analytics must come before the fit check")

    return out


if __name__ == "__main__":
    html = build()
    target = ROOT / "index.html"
    check_only = "--check" in sys.argv
    digest = hashlib.md5(html.encode()).hexdigest()
    if check_only:
        current = target.read_text() if target.exists() else ""
        if current != html:
            sys.exit("CHECK FAILED: index.html is stale, run scripts/build.py and commit the result")
        print("index.html is up to date (%d bytes, md5 %s)" % (len(html), digest))
    else:
        target.write_text(html)
        print("wrote %s (%d bytes, md5 %s)" % (target, len(html), digest))
