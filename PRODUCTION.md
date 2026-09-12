# LensIQ recruiter site, production process

The site at **lensiq.company** is a single static page generated from one source
file. This document is the process of record. If a change did not go through
these steps, it is not in production.

## Ground rules

1. **The repository is the only source of truth.** Not a sandbox, not a local
   folder, not a chat session. Anything not committed here does not exist.
2. **Nobody edits `index.html` by hand.** It is generated. Edit `src/` and run
   the build. CI rejects a stale or hand-edited `index.html`.
3. **Every change reaches production the same way**: commit, push, CI, deploy.
   There is no manual upload path and no "quick fix in the dashboard".
4. **No hardcoded values.** Project ids, keys and URLs come from repository
   secrets or from `src/`, never from a script body.

## Repository layout

```
src/site.master.html   Single source of truth: markup, styles, charts, data.
                       Line 1 is the title used by the Claude artifact build.
src/head.html          SEO head for the hosted variant (title, description, OG).
src/ask.js             API-backed Q&A and LinkedIn share block. Replaces the
                       offline FACTS block at build time.
scripts/build.py       Deterministic build. src/ -> index.html.
scripts/smoke.js       Real-browser smoke test against the built page.
scripts/sync_supabase.py  Publishes index.html into app_config.page_html.
index.html             Build output. Committed so the host needs no build step.
.nojekyll              Stops GitHub Pages running Jekyll over the output.
```

## The build

```bash
python3 scripts/build.py            # regenerate index.html
python3 scripts/build.py --check    # fail if index.html is stale (CI uses this)
```

The build is deterministic: identical inputs produce identical bytes, so the
md5 in the build log is a real fingerprint of what ships. It performs three
transforms and then refuses to emit anything that fails its own assertions:

| Transform | Why |
|---|---|
| Strip line 1 | The artifact build needs a title line, the web page does not. |
| Reveal the ask box, add the email field and the offline note | The hosted page has a backend; the offline artifact does not. |
| Replace the `FACTS` block with `src/ask.js` | Answers come from the live API, not a baked-in copy. |

Guards that fail the build: a missing or duplicated anchor, a leaked offline
`FACTS` block, a missing `#analytics` / `#anapanel` / `#sankey` / `#fit` /
`#qemail`, or the analytics section appearing before the fit check.

## The tests

```bash
node scripts/smoke.js
```

Thirteen checks in a real Chromium against the built file: section order, every
chart actually drawing, a chart click filling the right-hand detail panel, the
fit check scoring a spec and listing provenance, no horizontal overflow at
400px, and zero JavaScript errors. CI fails on any one of them.

## The pipeline

`.github/workflows/deploy.yml`, on every push and pull request to `main`:

1. `scripts/build.py --check` proves `index.html` matches `src/`.
2. Playwright installs and `scripts/smoke.js` runs the thirteen checks.
3. On `main` only, `scripts/sync_supabase.py` publishes the same bytes into
   `app_config.page_html` and verifies by reading the row back and comparing
   md5.

Hosting deploys from the same commit (see below). One commit, one set of bytes,
three surfaces: the domain, the Supabase-served page, and the Claude artifact.

## Hosting: Cloudflare Pages

Connected once, then every push to `main` deploys automatically. No tokens in
this repo, no upload step, no human in the deploy path.

One-time setup, done in the Cloudflare dashboard by the account owner:

1. Workers & Pages, Create, Pages, Connect to Git, authorise GitHub, pick
   `DanielDeenik/lensiq`.
2. Production branch `main`. Build command: leave empty. Build output
   directory: `/`. `index.html` is committed, so there is nothing to build.
3. Custom domains, add `lensiq.company` and `www.lensiq.company`. Cloudflare
   writes the DNS records itself because the zone is already on the account,
   and issues the certificate.
4. Deployments, confirm the first build is green and the domain serves it.

GitHub Pages stays enabled as a fallback mirror at
`danieldeenik.github.io/lensiq`. It serves the same committed `index.html`, so
the two can never drift. Disable it once the domain is stable if you prefer a
single front door.

## Secrets

Repository secrets, Settings, Secrets and variables, Actions:

| Secret | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | `sync_supabase.py` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `sync_supabase.py` | service_role key. Never commit it. |

The Kimi key for live answers lives in Supabase (`app_config.ai_api_key`, or the
edge secret `AI_API_KEY`, which wins), not here. The site calls the edge
function; the key never reaches the browser.

## Making a change

```bash
git switch -c change/<short-name>
# edit src/site.master.html (or src/head.html, src/ask.js)
python3 scripts/build.py
node scripts/smoke.js
git add src index.html
git commit -m "feat(site): <what changed and why>"
git push -u origin change/<short-name>
```

Open a pull request. CI runs build-check and the smoke tests on the PR. Merge to
`main` when green. Cloudflare Pages deploys the merge commit and the Supabase
job publishes the same bytes. Verify the live URL, then you are done.

Rollback is `git revert <sha>` and push. The same pipeline puts the previous
bytes back; there is nothing to undo by hand.

## What "done" means

A change is done when all four are true:

1. CI is green on `main`.
2. The Cloudflare Pages deployment for that commit is live.
3. `https://lensiq.company` returns the expected bytes, checked by fetching the
   page back, not by assuming.
4. `app_config.page_html` md5 matches the build log md5.
