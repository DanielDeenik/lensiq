# LensIQ recruiter agent, production process

The repository is the only source of truth. Nobody edits `index.html` by hand, nobody
hand deploys, and no value that can change is written into code. Every change is a
commit, a build, a smoke run, a push, and an automatic deploy.

## What the system is

A recruiter lands on `lensiq.company`. They can do three things:

1. **Ask a question.** It is answered live if an AI key is configured, otherwise queued
   for the scheduled agent.
2. **Paste a job spec.** The browser scores an instant fit check. When they send it in,
   an `applications` row is created. The scheduled agent writes a fit report, a CV
   rewritten against that spec, and a matching cover letter, then holds all three for
   Dan. **Nothing reaches the recruiter until Dan approves it in his console.**
3. **Book a call.** Open slots are computed from config minus Dan's real Google Calendar
   busy blocks minus anything already held. A booking is held, never booked. Dan
   confirms it in the console and the agent then creates the event, attaches the
   meeting link and invites the recruiter.

Behind that, privately for Dan only, a role monitor scores the market against his
profile and a seasonality model tells him when demand is worth chasing.

## Layout

```
src/site.master.html   the page, single source, artifact skeleton format
src/head.html          the html head the build wraps around it
src/ask.js             the hosted ask box, swapped in at build time
src/console.html       Dan's private console markup
scripts/build.py       src to index.html and dist/index.html, deterministic
scripts/smoke.js       19 checks in a real browser, plus one live endpoint check
scripts/cfg.py         push a file or value into app_config through the console
scripts/sync_supabase.py  publish index.html to app_config.page_html
supabase/functions/site     public edge function: page, ask, spec, slots, book
supabase/functions/console  private edge function: approvals, role monitor, config
supabase/migrations         schema, in order
agents/                the two scheduled task prompts, version controlled
config/                the nexus feed model and the CV tailoring rules
index.html, dist/      build output, committed so the deploy is reproducible
wrangler.toml          Cloudflare Workers static assets config
```

## Commands

```
python3 scripts/build.py            rebuild index.html and dist/index.html
python3 scripts/build.py --check    fail if either is stale
node scripts/smoke.js               19 browser checks plus the live slots endpoint
```

The build refuses to emit if the fit check is not before the analytics section, if a
required element id is missing, or if the offline FACTS block leaks into the hosted page.

## Deploying

**The site.** Commit and push to `main`. Cloudflare Workers Builds runs on push and
serves `dist/` at `lensiq.company`. No manual step.

**The page inside Supabase.** The `site` edge function serves `app_config.page_html`
so the agent can update copy without a redeploy. After a site change, publish it:

```
export CONSOLE_BASE="https://hvitxwhfdhsdwhgllaqf.supabase.co/functions/v1/console"
export CONSOLE_TOKEN="<console_token from app_config>"
python3 scripts/cfg.py set page_html index.html
```

**The edge functions.** Edit `supabase/functions/<name>/index.ts`, then deploy that exact
file with the Supabase MCP `deploy_edge_function` tool, `verify_jwt` false for both.
Never edit a deployed function in the dashboard: the repo copy would go stale.

**The console markup.** `src/console.html` is served from `app_config.console_html`:

```
python3 scripts/cfg.py set console_html src/console.html
```

**The schema.** Apply `supabase/migrations/*.sql` in order. Every statement is idempotent.

## Configuration, none of it in code

Everything that can change lives in `app_config`. The important keys:

| key | what it controls |
| --- | --- |
| `page_html` | the public page the edge function serves |
| `console_html` | Dan's private console markup |
| `console_token` | the only thing gating the console, 24 random bytes |
| `console_base_url` | where the database cron sends the role refresh |
| `fact_base`, `sharing_rules` | what the agent may say about Dan |
| `cv_master_md` | the CV every tailored version is derived from |
| `cv_tailoring_rules` | the rules the agent must follow when rewriting it |
| `nexus_agent_config` | feed sources, keyword scores, seasonality model, from nexus_live |
| `nexus_profile_industry`, `nexus_profile_location` | which seasonality curve applies |
| `nexus_roles_min_tier`, `nexus_roles_keep_days` | what is worth keeping |
| `adzuna_app_id`, `adzuna_app_key` | absent by default; setting them arms four dormant sources |
| `call_window`, `call_durations`, `call_timezone` | the slot grid the site offers |
| `call_lead_hours`, `call_horizon_days`, `call_max_per_day` | how far out and how dense |
| `call_daily_cap` | booking rate limit |
| `default_delivery_mode` | `draft` or `send` for approved applications |

A feed source may declare `needs: ["some_config_key"]` and use `{{some_config_key}}` in
its url. It stays dormant until that key holds a value, then arms itself on the next
scan. That is how a credential turns on coverage without a code change.

## Scheduled work

| what | when | where |
| --- | --- | --- |
| role monitor refresh | 04:00 and 13:00 UTC | pg_cron in the database, calls the console endpoint |
| recruiter agent | every hour at :45 | scheduled task, calendar sync, tailoring, delivery, call invites |
| market brief for Dan | 05:00 UTC weekdays | scheduled task, role and seasonality email |

The role monitor runs in the database on purpose. It does not depend on an agent
session being alive, so a silent day means no roles, not a broken monitor.

## Definition of done

1. `python3 scripts/build.py --check` passes.
2. `node scripts/smoke.js` is green, all 19.
3. The commit is pushed to `main` and Cloudflare has deployed it.
4. `app_config.page_html` matches `index.html` byte for byte.
