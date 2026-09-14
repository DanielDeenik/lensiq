import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Private console for Dan. Token gated, never linked from the public site.
// The page markup lives in app_config (key console_html) and the feed model in
// app_config (key nexus_agent_config, generated from the nexus_live sources),
// so content and model changes are config writes, never redeploys.
// A source that declares `needs` stays dormant until every named config key
// holds a value, and its url may carry {{config_key}} placeholders. That means
// pasting an API credential into config arms new sources with no code change.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COOKIE = "lensiq_console";

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function config(): Promise<Record<string, string>> {
  const res = await rest("app_config?select=key,value");
  const rows: { key: string; value: string }[] = res.ok ? await res.json() : [];
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenFrom(req: Request, url: URL): string {
  const q = url.searchParams.get("k");
  if (q) return q;
  const h = req.headers.get("x-console-token");
  if (h) return h;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.get("cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : "";
}

async function logRun(kind: string, ok: boolean, items: number, detail: unknown) {
  await rest("agent_runs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ kind, ok, items, detail }) });
}

// ---------- Feed model ----------

type Source = {
  id: string; name: string; authority: number; jurisdiction: string; url: string;
  kind?: "rss" | "json";
  needs?: string[];
  // A watchlist source is a named firm that actually places Dan, polled through
  // its own public ATS. Those deserve a lower floor than a generic job board:
  // one opening at Alpha FMC matters more than a hundred rows from an aggregator.
  watchlist?: boolean;
  minScore?: number;
  // An ATS feed carries the location where a job board carries the employer, so
  // a watchlist source names its own firm and the location moves into the text.
  company?: string;
  map?: { list?: string; title: string; company?: string; link: string; date?: string; snippet?: string };
  headers?: Record<string, string>;
};

type NexusConfig = {
  sources: Source[];
  keywords: { re: string; flags: string; pts: number; tier: string }[];
  scoring: {
    recency: { noDate: number; bands: { maxDays: number; mult: number }[]; older: number };
    tiers: { min: number; tier: string }[];
    tierFloor: string; dedupKeyLen: number; scoreCap: number; multiSourceBonus: number;
  };
  seasonality: { months: string[]; terms: Record<string, string>; presets: Record<string, number[]> };
};

type Item = { title: string; company: string; link: string; date: string; snippet: string };

function missingNeeds(src: Source, cfg: Record<string, string>): string[] {
  return (src.needs ?? []).filter((k) => !cfg[k] || !cfg[k].trim());
}

function expand(url: string, cfg: Record<string, string>): string {
  return url.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_m, k) => encodeURIComponent(cfg[k] ?? ""));
}

// Some feeds deliver HTML, some deliver HTML that has been entity escaped a
// second time. Unescape first, then strip tags, then unescape what the tags hid,
// or the markup survives into both the display text and the scored text.
function unescapeEntities(v: string): string {
  return v
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function clean(s: string): string {
  let v = String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  for (let i = 0; i < 2; i++) {
    v = unescapeEntities(v).replace(/<[^>]+>/g, " ");
  }
  return unescapeEntities(v).replace(/\s+/g, " ").trim();
}

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (m && clean(m[1])) return clean(m[1]);
    const self = new RegExp(`<${n}[^>]*href="([^"]+)"[^>]*/?>`, "i").exec(block);
    if (self) return clean(self[1]);
  }
  return "";
}

function parseRss(xml: string): Item[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map((b) => ({
    title: tag(b, ["title"]),
    company: tag(b, ["dc:creator", "author", "source"]),
    link: tag(b, ["link", "guid", "id"]),
    date: tag(b, ["pubDate", "published", "updated", "dc:date"]),
    snippet: tag(b, ["description", "summary", "content"]).slice(0, 600),
  })).filter((i) => i.title);
}

function dig(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function parseJson(payload: unknown, map: Source["map"]): Item[] {
  if (!map) return [];
  const list = dig(payload, map.list);
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const d = dig(raw, map.date);
    let date = "";
    if (typeof d === "number") date = new Date(d * (d > 1e11 ? 1 : 1000)).toISOString();
    else if (d) date = String(d);
    return {
      title: clean(String(dig(raw, map.title) ?? "")),
      company: clean(String(dig(raw, map.company) ?? "")),
      link: String(dig(raw, map.link) ?? ""),
      date,
      snippet: clean(String(dig(raw, map.snippet) ?? "")).slice(0, 600),
    };
  }).filter((i) => i.title);
}

async function fetchSource(src: Source, cfg: Record<string, string>): Promise<{ items: Item[]; report: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(expand(src.url, cfg), {
      signal: ctl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LensIQ role monitor)",
        Accept: "application/json, application/rss+xml, application/xml, text/xml, */*",
        ...(src.headers ?? {}),
      },
    });
    if (!res.ok) return { items: [], report: `http_${res.status}` };
    const body = await res.text();
    const kind = src.kind ?? (body.trimStart().startsWith("{") || body.trimStart().startsWith("[") ? "json" : "rss");
    const items = kind === "json" ? parseJson(JSON.parse(body), src.map) : parseRss(body);
    return { items, report: `ok_${items.length}` };
  } catch (e) {
    return { items: [], report: `error_${(e as Error).name}` };
  } finally {
    clearTimeout(timer);
  }
}

function recency(nx: NexusConfig, date: string): number {
  const r = nx.scoring.recency;
  if (!date) return r.noDate;
  const t = new Date(date).getTime();
  if (!isFinite(t)) return r.noDate;
  const days = (Date.now() - t) / 86400000;
  for (const band of r.bands) if (days < band.maxDays) return band.mult;
  return r.older;
}

function tierOf(nx: NexusConfig, score: number): string {
  for (const t of nx.scoring.tiers) if (score >= t.min) return t.tier;
  return nx.scoring.tierFloor;
}

function scoreAll(nx: NexusConfig, src: Source, items: Item[]) {
  const regexes = nx.keywords.map((k) => ({ ...k, rx: new RegExp(k.re, k.flags || "i") }));
  return items.map((it) => {
    const text = `${it.title} ${it.company} ${it.snippet}`;
    let raw = 0;
    const matches: { keyword: string; pts: number; tier: string }[] = [];
    for (const k of regexes) {
      if (k.rx.test(text)) { raw += k.pts; if (k.pts > 0) matches.push({ keyword: k.re, pts: k.pts, tier: k.tier }); }
    }
    const score = Math.round(raw * recency(nx, it.date) * src.authority);
    return {
      fingerprint: `${it.title} ${src.company ?? it.company}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, nx.scoring.dedupKeyLen),
      title: it.title.slice(0, 300),
      company: src.company ?? (it.company ? it.company.slice(0, 200) : null),
      link: it.link.slice(0, 1000),
      jurisdiction: src.jurisdiction,
      source_ids: [src.id],
      watchlist: Boolean(src.watchlist),
      floor: typeof src.minScore === "number" ? src.minScore : null,
      pub_date: it.date && isFinite(new Date(it.date).getTime()) ? new Date(it.date).toISOString() : null,
      score, tier: tierOf(nx, score), matches,
      snippet: (src.company && it.company ? it.company + ". " : "") + it.snippet.slice(0, 560),
    };
  }).filter((i) => i.fingerprint);
}

function dedup(nx: NexusConfig, rows: ReturnType<typeof scoreAll>) {
  const merged = new Map<string, (typeof rows)[number]>();
  for (const item of rows) {
    const prev = merged.get(item.fingerprint);
    if (!prev) { merged.set(item.fingerprint, item); continue; }
    const ids = [...new Set([...prev.source_ids, ...item.source_ids])];
    const best = item.score > prev.score ? item : prev;
    const boosted = ids.length > 1 ? Math.min(nx.scoring.scoreCap, best.score + nx.scoring.multiSourceBonus) : best.score;
    merged.set(item.fingerprint, { ...best, source_ids: ids, score: boosted, tier: tierOf(nx, boosted) });
  }
  return [...merged.values()];
}

function sourceStatus(nx: NexusConfig, cfg: Record<string, string>) {
  return nx.sources.map((s) => {
    const missing = missingNeeds(s, cfg);
    return { id: s.id, name: s.name, jurisdiction: s.jurisdiction, active: missing.length === 0, missing };
  });
}

async function scanRoles(nx: NexusConfig, cfg: Record<string, string>, minTier: string, dryRun: boolean, only?: Source[]) {
  const candidates = only && only.length ? only : nx.sources;
  const report: Record<string, string> = {};
  const samples: Record<string, string> = {};
  const sources = candidates.filter((s) => {
    const missing = missingNeeds(s, cfg);
    if (missing.length) { report[s.id] = `dormant_needs_${missing.join("_")}`; return false; }
    return true;
  });
  let all: ReturnType<typeof scoreAll> = [];

  await Promise.all(sources.map(async (src) => {
    const { items, report: r } = await fetchSource(src, cfg);
    report[src.id] = r;
    if (items[0]) samples[src.id] = items[0].title.slice(0, 90);
    all = all.concat(scoreAll(nx, src, items));
  }));

  const order = [...nx.scoring.tiers.map((t) => t.tier), nx.scoring.tierFloor];
  const cutoff = order.indexOf(minTier) < 0 ? order.length - 1 : order.indexOf(minTier);
  const ranked = dedup(nx, all).sort((a, b) => b.score - a.score);
  // A row clears either the global tier bar or its own source's floor.
  const keep = ranked.filter((i) =>
    order.indexOf(i.tier) <= cutoff || (typeof i.floor === "number" && i.score >= i.floor));

  if (!dryRun && keep.length) {
    const now = new Date().toISOString();
    await rest("role_signals?on_conflict=fingerprint", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(keep.map(({ floor: _floor, ...k }) => ({ ...k, last_seen: now }))),
    });
  }
  return { kept: keep.length, seen: all.length, sources: report, samples, top: ranked.slice(0, 5).map((k) => `${k.score} ${k.title}`) };
}

// ---------- Seasonality ----------

async function seasonality(nx: NexusConfig, industry: string, location: string, ttlHours: number) {
  const cached = await rest(`seasonality_cache?select=*&industry=eq.${encodeURIComponent(industry)}&location=eq.${encodeURIComponent(location)}`);
  if (cached.ok) {
    const rows: { data: Record<string, unknown>; source: string; expires_at: string }[] = await cached.json();
    if (rows[0] && new Date(rows[0].expires_at).getTime() > Date.now()) {
      return { ...rows[0].data, source: rows[0].source, fresh: false };
    }
  }
  const model = nx.seasonality.presets[industry] ?? nx.seasonality.presets["default"];
  const months = nx.seasonality.months;
  const ranked = model.map((v, i) => ({ m: months[i], v }));
  const peak = [...ranked].sort((a, b) => b.v - a.v).slice(0, 3).map((x) => x.m);
  const slow = [...ranked].sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.m);
  const data = { industry, location, months, model, peak, slow, term: nx.seasonality.terms[industry] ?? null };
  await rest("seasonality_cache?on_conflict=industry,location", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ industry, location, data, source: "nexus_model", fetched_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString() }]),
  });
  return { ...data, source: "nexus_model", fresh: true };
}

async function observedByMonth(months: string[]) {
  const res = await rest("role_signals?select=first_seen&order=first_seen.asc&limit=5000");
  const counts = new Array(12).fill(0);
  if (res.ok) {
    const rows: { first_seen: string }[] = await res.json();
    for (const r of rows) {
      const d = new Date(r.first_seen);
      if (isFinite(d.getTime())) counts[d.getUTCMonth()]++;
    }
  }
  const max = Math.max(...counts, 1);
  return { months, counts, index: counts.map((c) => Math.round((c / max) * 100)), total: counts.reduce((a, b) => a + b, 0) };
}

// ---------- Routing ----------

function actPage(headline: string, detail: string, cfg: Record<string, string>): Response {
  const base = cfg["console_public_url"] ?? cfg["console_base_url"] ?? "";
  const link = base ? `${base}/?k=${encodeURIComponent(cfg["console_token"] ?? "")}` : "";
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>LensIQ</title><style>
:root{--bg:#f6f5f1;--paper:#fff;--ink:#15171b;--body:#2c3038;--muted:#6b7280;--line:#e3e1da;--lemon:#e8f04a}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--body);
font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px}
.c{background:var(--paper);border:1px solid var(--line);border-top:4px solid var(--lemon);border-radius:14px;
padding:28px 30px;max-width:520px;box-shadow:0 10px 30px rgba(21,23,27,.08)}
h1{margin:0 0 10px;font-size:20px;color:var(--ink);line-height:1.3}
p{margin:0 0 18px;font-size:15px;line-height:1.55}
a{display:inline-block;padding:10px 18px;border-radius:9px;background:var(--lemon);border:1px solid var(--ink);
color:var(--ink);font-weight:700;text-decoration:none;font-size:14px}
</style></head><body><div class="c"><h1>${esc(headline)}</h1><p>${esc(detail)}</p>
${link ? `<a href="${esc(link)}">Open the console</a>` : ""}</div></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/console/, "").replace(/\/$/, "") || "/";
  const cfg = await config();
  const expected = cfg["console_token"] ?? "";
  if (!expected) return json({ error: "console_not_configured" }, 503);

  // One click approval from the email Dan gets. The link carries a token that is
  // scoped to a single row, never the console master token, so forwarding an
  // email cannot hand anyone the console.
  if (path === "/act") {
    const kind = url.searchParams.get("kind") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const act = url.searchParams.get("do") ?? "";
    const tok = url.searchParams.get("t") ?? "";
    const table = kind === "call" ? "call_requests" : kind === "app" ? "applications" : "";
    if (!table || !/^\d+$/.test(id) || !tok) return actPage("That link is not complete", "Open the console and act there instead.", cfg);

    const look = await rest(`${table}?select=*&id=eq.${id}&action_token=eq.${encodeURIComponent(tok)}`);
    const rows = look.ok ? await look.json() : [];
    const row = rows[0];
    if (!row) return actPage("That link is no longer valid", "It may already have been used, or the item was removed. Open the console to see where things stand.", cfg);

    const patch: Record<string, unknown> = {};
    let headline = "";
    if (table === "applications") {
      if (row.status !== "pending_approval") {
        return actPage("Already decided", `This one is already marked ${String(row.status).replace(/_/g, " ")}. Nothing changed.`, cfg);
      }
      if (act === "approve_draft") { patch.status = "approved"; patch.delivery = "draft"; patch.approved_at = new Date().toISOString(); headline = "Approved. The agent will put the pack in your Gmail as a draft."; }
      else if (act === "approve_send") { patch.status = "approved"; patch.delivery = "send"; patch.approved_at = new Date().toISOString(); headline = "Approved and queued to send. The agent sends it on its next pass."; }
      else if (act === "reject") { patch.status = "rejected"; headline = "Rejected. Nothing goes out."; }
      else return actPage("Unknown action", "Open the console and act there instead.", cfg);
    } else {
      if (row.status !== "held") {
        return actPage("Already decided", `This call is already ${String(row.status)}. Nothing changed.`, cfg);
      }
      if (act === "confirm") { patch.status = "confirmed"; patch.confirmed_at = new Date().toISOString(); headline = "Confirmed. The agent creates the event and sends the invite on its next pass."; }
      else if (act === "decline") { patch.status = "declined"; headline = "Declined. They get a short note and the booking page."; }
      else return actPage("Unknown action", "Open the console and act there instead.", cfg);
    }

    const res = await rest(`${table}?id=eq.${id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!res.ok) return actPage("That did not save", "Open the console and try there.", cfg);
    const what = table === "applications"
      ? `${row.role_title ?? "the role"}${row.company ? " at " + row.company : ""}`
      : `the call on ${new Date(row.slot_start).toLocaleString("en-GB", { timeZone: cfg["call_timezone"] ?? "UTC", weekday: "long", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    return actPage(headline, what, cfg);
  }

  if (!safeEqual(tokenFrom(req, url), expected)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const setCookie = url.searchParams.get("k")
    ? { "Set-Cookie": `${COOKIE}=${encodeURIComponent(expected)}; Path=/console; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000` }
    : {};
  const nexus: NexusConfig | null = cfg["nexus_agent_config"] ? JSON.parse(cfg["nexus_agent_config"]) : null;

  if (path === "/") {
    const html = cfg["console_html"] ?? "<title>LensIQ console</title><p>Console markup is not loaded.</p>";
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...setCookie } });
  }

  if (path === "/api/state" && req.method === "GET") {
    const [appsRes, rolesRes, runsRes, callsRes] = await Promise.all([
      rest("applications?select=*&order=created_at.desc&limit=60"),
      rest("role_signals?select=*&order=score.desc,last_seen.desc&limit=120"),
      rest("agent_runs?select=*&order=ran_at.desc&limit=12"),
      rest("call_requests?select=*&order=slot_start.asc&limit=60"),
    ]);
    const applications = appsRes.ok ? await appsRes.json() : [];
    const roles = rolesRes.ok ? await rolesRes.json() : [];
    const runs = runsRes.ok ? await runsRes.json() : [];
    const calls = callsRes.ok ? await callsRes.json() : [];
    let season = null, observed = null, sources = null;
    if (nexus) {
      season = await seasonality(nexus, cfg["nexus_profile_industry"] ?? "default", cfg["nexus_profile_location"] ?? "NL", parseInt(cfg["nexus_seasonality_ttl_hours"] || "168", 10));
      observed = await observedByMonth(nexus.seasonality.months);
      sources = sourceStatus(nexus, cfg);
    }
    return json({ applications, roles, runs, calls, season, observed, sources, nexus_configured: Boolean(nexus), defaults: { delivery: cfg["default_delivery_mode"] ?? "draft", call_timezone: cfg["call_timezone"] ?? "UTC" } }, 200, setCookie);
  }

  if (path === "/api/application" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !body.id) return json({ error: "bad_request" }, 400);
    const patch: Record<string, unknown> = {};
    if (typeof body.cv_md === "string") patch.cv_md = body.cv_md;
    if (typeof body.cover_letter_md === "string") patch.cover_letter_md = body.cover_letter_md;
    if (typeof body.dan_notes === "string") patch.dan_notes = body.dan_notes;
    if (body.delivery === "draft" || body.delivery === "send") patch.delivery = body.delivery;
    if (body.action === "approve") { patch.status = "approved"; patch.approved_at = new Date().toISOString(); }
    if (body.action === "reject") patch.status = "rejected";
    if (body.action === "reopen") { patch.status = "pending_approval"; patch.approved_at = null; }
    if (!Object.keys(patch).length) return json({ error: "nothing_to_do" }, 400);
    const res = await rest(`applications?id=eq.${encodeURIComponent(String(body.id))}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
    });
    if (!res.ok) return json({ error: "update_failed", detail: await res.text() }, 500);
    const rows = await res.json();
    return json({ ok: true, application: rows[0] ?? null }, 200, setCookie);
  }

  if (path === "/api/call" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !body.id) return json({ error: "bad_request" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.action === "confirm") { patch.status = "confirmed"; patch.confirmed_at = new Date().toISOString(); }
    else if (body.action === "decline") { patch.status = "declined"; patch.declined_reason = String(body.reason ?? "").slice(0, 500) || null; }
    else return json({ error: "bad_action" }, 400);
    const res = await rest(`call_requests?id=eq.${encodeURIComponent(String(body.id))}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
    });
    if (!res.ok) return json({ error: "update_failed", detail: await res.text() }, 500);
    const rows = await res.json();
    return json({ ok: true, call: rows[0] ?? null }, 200, setCookie);
  }

  if (path === "/api/roles/seen" && req.method === "POST") {
    const res = await rest("role_signals?seen_by_dan=eq.false", {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ seen_by_dan: true }),
    });
    return json({ ok: res.ok }, res.ok ? 200 : 500, setCookie);
  }

  if (path === "/api/roles/refresh") {
    if (!nexus) return json({ error: "nexus_config_missing" }, 409);
    const started = Date.now();
    const out = await scanRoles(nexus, cfg, cfg["nexus_roles_min_tier"] ?? "MONITOR", false);
    await logRun("roles_refresh", true, out.kept, { sources: out.sources, seen: out.seen, top: out.top, ms: Date.now() - started });
    return json({ ok: true, ...out, ms: Date.now() - started }, 200, setCookie);
  }

  if (path === "/api/roles/probe" && req.method === "POST") {
    if (!nexus) return json({ error: "nexus_config_missing" }, 409);
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.sources)) return json({ error: "bad_request" }, 400);
    const out = await scanRoles(nexus, cfg, cfg["nexus_roles_min_tier"] ?? "MONITOR", true, body.sources as Source[]);
    return json({ ok: true, ...out }, 200, setCookie);
  }

  if (path === "/api/config" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.key !== "string" || typeof body.value !== "string") return json({ error: "bad_request" }, 400);
    const res = await rest("app_config?on_conflict=key", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ key: body.key, value: body.value, updated_at: new Date().toISOString() }]),
    });
    return json({ ok: res.ok, key: body.key, bytes: body.value.length }, res.ok ? 200 : 500, setCookie);
  }

  if (path === "/api/config" && req.method === "GET") {
    const key = url.searchParams.get("key") ?? "";
    return json({ key, value: cfg[key] ?? null }, 200, setCookie);
  }

  return json({ error: "not_found", path }, 404);
});
