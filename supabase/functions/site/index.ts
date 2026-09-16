import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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

async function loadConfig(): Promise<Record<string, string>> {
  const res = await rest("app_config?select=key,value");
  if (!res.ok) throw new Error(`config load failed: ${res.status}`);
  const rows: { key: string; value: string }[] = await res.json();
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

// The page itself lives in app_config (key page_html) so content updates are a SQL
// update by the batch agent, never a redeploy. Cached in memory for 5 minutes.
let pageCache = { html: "", at: 0 };
async function loadPage(): Promise<string> {
  if (pageCache.html && Date.now() - pageCache.at < 300_000) return pageCache.html;
  const res = await rest("app_config?select=value&key=eq.page_html");
  if (res.ok) {
    const rows: { value: string }[] = await res.json();
    if (rows[0]?.value) pageCache = { html: rows[0].value, at: Date.now() };
  }
  return pageCache.html || "<title>Dan Deenik</title><p>Site content is loading. Contact deenikdaniel@gmail.com.</p>";
}

async function countRows(filter: string): Promise<number> {
  const res = await rest(`qa_log?select=id&${filter}`, {
    method: "HEAD",
    headers: { Prefer: "count=exact" },
  });
  const range = res.headers.get("content-range") ?? "*/0";
  return parseInt(range.split("/")[1] || "0", 10) || 0;
}

async function logRow(row: Record<string, unknown>): Promise<void> {
  await rest("qa_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
}

async function logRowReturning(row: Record<string, unknown>): Promise<number | null> {
  const res = await rest("qa_log?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) return null;
  const rows: { id: number }[] = await res.json();
  return rows[0]?.id ?? null;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------- Call scheduling ----------
// Slots are computed from config, minus Dan's real calendar busy blocks and
// minus anything already held or confirmed. A booking is only ever held here:
// nothing reaches Dan's calendar until he confirms it in his console.

type CallWindow = { days: number[]; start: string; end: string };
type CallDuration = { id: string; minutes: number; label: string };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const hh = p.hour === "24" ? 0 : parseInt(p.hour, 10);
  return {
    wd: WEEKDAYS.indexOf(p.weekday),
    hh, mm: parseInt(p.minute, 10),
    date: `${p.year}-${p.month}-${p.day}`,
    label: `${p.weekday} ${p.day}/${p.month}`,
  };
}

function hhmm(v: string): number {
  const [h, m] = v.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

async function openSlots(cfg: Record<string, string>) {
  const tz = cfg["call_timezone"] || "UTC";
  const win: CallWindow = JSON.parse(cfg["call_window"] || '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}');
  const durations: CallDuration[] = JSON.parse(cfg["call_durations"] || '[{"id":"intro","minutes":30,"label":"Intro call"}]');
  const step = parseInt(cfg["call_slot_step_minutes"] || "15", 10);
  const lead = parseInt(cfg["call_lead_hours"] || "24", 10);
  const horizon = parseInt(cfg["call_horizon_days"] || "14", 10);
  const maxPerDay = parseInt(cfg["call_max_per_day"] || "3", 10);
  const minutes = Math.max(...durations.map((d) => d.minutes));

  const from = new Date(Date.now() + lead * 3600_000);
  const to = new Date(Date.now() + horizon * 86400_000);

  const [busyRes, takenRes] = await Promise.all([
    rest(`calendar_busy?select=start_at,end_at&end_at=gte.${from.toISOString()}&start_at=lte.${to.toISOString()}`),
    rest(`call_requests?select=slot_start,slot_end&status=in.(held,confirmed)&slot_end=gte.${from.toISOString()}`),
  ]);
  const busy: { start_at: string; end_at: string }[] = busyRes.ok ? await busyRes.json() : [];
  const taken: { slot_start: string; slot_end: string }[] = takenRes.ok ? await takenRes.json() : [];

  const perDay: Record<string, number> = {};
  for (const t of taken) {
    const k = localParts(new Date(t.slot_start), tz).date;
    perDay[k] = (perDay[k] ?? 0) + 1;
  }

  const winStart = hhmm(win.start);
  const winEnd = hhmm(win.end);
  const slots: { start: string; end: string; date: string; day: string; time: string }[] = [];
  const stepMs = step * 60_000;
  let cursor = Math.ceil(from.getTime() / stepMs) * stepMs;

  for (; cursor <= to.getTime() && slots.length < 300; cursor += stepMs) {
    const start = new Date(cursor);
    const p = localParts(start, tz);
    if (!win.days.includes(p.wd)) continue;
    const mins = p.hh * 60 + p.mm;
    if (mins < winStart || mins + minutes > winEnd) continue;
    if ((perDay[p.date] ?? 0) >= maxPerDay) continue;
    const end = new Date(cursor + minutes * 60_000);
    if (busy.some((b) => new Date(b.start_at) < end && new Date(b.end_at) > start)) continue;
    if (taken.some((b) => new Date(b.slot_start) < end && new Date(b.slot_end) > start)) continue;
    slots.push({
      start: start.toISOString(), end: end.toISOString(),
      date: p.date, day: p.label,
      time: `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`,
    });
  }

  return {
    timezone: tz, window: win, durations, slots,
    location: cfg["call_location"] ?? "Google Meet",
    calendar_synced: busy.length > 0,
    // When Dan runs a Google appointment schedule, that is the booking system and
    // this grid steps aside. One config key decides it, no redeploy.
    booking_url: (cfg["booking_url"] ?? "").trim() || null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const path = new URL(req.url).pathname.replace(/^\/site/, "").replace(/\/$/, "") || "/";

  // Public proof that the machine runs. Counts only: no names, no role titles,
  // no recruiter data, nothing from Dan's private market monitor.
  if (req.method === "GET" && path === "/pulse") {
    async function countOf(table: string, filter = ""): Promise<number> {
      const res = await rest(`${table}?select=id${filter ? "&" + filter : ""}`, {
        method: "HEAD", headers: { Prefer: "count=exact" },
      });
      return parseInt((res.headers.get("content-range") ?? "*/0").split("/")[1] || "0", 10) || 0;
    }
    async function latest(table: string, column: string): Promise<string | null> {
      const res = await rest(`${table}?select=${column}&order=${column}.desc&limit=1`);
      if (!res.ok) return null;
      const rows = await res.json();
      return rows[0]?.[column] ?? null;
    }
    const [specs, calls, roles, answered, lastRun, lastScan, firstRun] = await Promise.all([
      countOf("applications"),
      countOf("call_requests", "status=in.(held,confirmed)"),
      countOf("role_signals"),
      countOf("qa_log", "status=eq.ok"),
      latest("agent_runs", "ran_at"),
      latest("role_signals", "last_seen"),
      (async () => {
        const res = await rest("agent_runs?select=ran_at&order=ran_at.asc&limit=1");
        if (!res.ok) return null;
        const rows = await res.json();
        return rows[0]?.ran_at ?? null;
      })(),
    ]);
    let scanned = 0, sourcesLive = 0;
    const runRes = await rest("agent_runs?select=items,detail&kind=eq.roles_refresh&order=ran_at.desc&limit=60");
    if (runRes.ok) {
      const runs: { items: number; detail: Record<string, unknown> | null }[] = await runRes.json();
      for (const r of runs) scanned += Number((r.detail as { seen?: number })?.seen ?? 0);
      const srcs = (runs[0]?.detail as { sources?: Record<string, string> })?.sources ?? {};
      sourcesLive = Object.values(srcs).filter((v) => String(v).startsWith("ok_")).length;
    }
    return new Response(JSON.stringify({
      specs_assessed: specs, calls_booked: calls, roles_tracked: roles,
      roles_scanned: scanned, sources_live: sourcesLive, questions_answered: answered,
      last_agent_run: lastRun, last_role_scan: lastScan, running_since: firstRun,
      generated_at: new Date().toISOString(),
    }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900", ...CORS } });
  }

  if (req.method === "GET" && path === "/slots") {
    let cfg: Record<string, string>;
    try {
      cfg = await loadConfig();
    } catch (_e) {
      return json({ error: "config_unavailable" }, 503);
    }
    try {
      return json(await openSlots(cfg));
    } catch (e) {
      return json({ error: "slots_unavailable", detail: (e as Error).message }, 500);
    }
  }

  if (req.method === "GET") {
    const html = await loadPage();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", ...CORS },
    });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (path === "/book") {
    let cfg: Record<string, string>;
    try {
      cfg = await loadConfig();
    } catch (_e) {
      return json({ error: "config_unavailable" }, 503);
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const slotStart = String(body.slot_start ?? "");
    const email = String(body.email ?? "").trim().slice(0, 200);
    const name = String(body.name ?? "").trim().slice(0, 120);
    const company = String(body.company ?? "").trim().slice(0, 160);
    const role = String(body.role ?? "").trim().slice(0, 200);
    const note = String(body.note ?? "").trim().slice(0, 1000);
    const durationId = String(body.duration_id ?? "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "bad_email" }, 400);

    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const ipHash = await sha256(ip);
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const capRes = await rest(`call_requests?select=id&created_at=gte.${dayStart.toISOString()}`, {
      method: "HEAD", headers: { Prefer: "count=exact" },
    });
    const capCount = parseInt((capRes.headers.get("content-range") ?? "*/0").split("/")[1] || "0", 10) || 0;
    const cap = parseInt(cfg["call_daily_cap"] || "0", 10);
    if (cap && capCount >= cap) return json({ error: "rate_limited" }, 429);

    const available = await openSlots(cfg);
    const match = available.slots.find((s) => s.start === slotStart);
    if (!match) return json({ error: "slot_gone", slots: available.slots.slice(0, 60) }, 409);
    const duration = available.durations.find((d) => d.id === durationId) ?? available.durations[0];

    const res = await rest("call_requests", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        requester_name: name || null, requester_email: email,
        company: company || null, role_title: role || null, note: note || null,
        slot_start: match.start, slot_end: match.end,
        duration_minutes: duration.minutes, timezone: available.timezone,
        status: "held", ip_hash: ipHash,
      }),
    });
    if (res.status === 409) return json({ error: "slot_gone" }, 409);
    if (!res.ok) return json({ error: "book_failed" }, 500);
    const rows = await res.json();
    return json({
      held: true, id: rows[0]?.id ?? null,
      when: `${match.day} at ${match.time}`, timezone: available.timezone,
      minutes: duration.minutes, location: available.location,
    }, 201);
  }

  let question = "";
  let email = "";
  let spec = "";
  let recruiterName = "";
  let company = "";
  let roleTitle = "";
  try {
    const body = await req.json();
    question = String(body.question ?? "").trim();
    email = String(body.email ?? "").trim().slice(0, 200);
    spec = String(body.spec ?? "").trim().slice(0, 8000);
    recruiterName = String(body.name ?? "").trim().slice(0, 120);
    company = String(body.company ?? "").trim().slice(0, 160);
    roleTitle = String(body.role ?? body.role_title ?? "").trim().slice(0, 200);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!question || question.length > 300) return json({ error: "bad_question" }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) email = "";

  let cfg: Record<string, string>;
  try {
    cfg = await loadConfig();
  } catch (_e) {
    return json({ error: "config_unavailable" }, 503);
  }

  // Rate limits, values from config, never hardcoded. Applied to live and queued paths alike.
  const dailyCap = parseInt(cfg["ask_daily_cap"] || "0", 10);
  const ipCap = parseInt(cfg["ask_hourly_ip_cap"] || "0", 10);
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const ipHash = await sha256(ip);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();

  const [dayCount, ipCount] = await Promise.all([
    countRows(`asked_at=gte.${dayStart.toISOString()}`),
    countRows(`ip_hash=eq.${ipHash}&asked_at=gte.${hourAgo}`),
  ]);
  if ((dailyCap && dayCount >= dailyCap) || (ipCap && ipCount >= ipCap)) {
    return json({ error: "rate_limited" }, 429);
  }

  // A pasted job spec starts an application. The fit report, the CV rewritten
  // against this spec and the cover letter are all produced by the scheduled
  // agent and held for Dan's approval. Nothing here reaches the sender.
  if (spec) {
    const stored = `${question}\n\nFULL SPEC:\n${spec}`;
    const qaId = await logRowReturning({
      ip_hash: ipHash,
      question: stored,
      answer: null,
      status: "queued",
      asker_email: email || null,
    });
    const appRes = await rest("applications", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        qa_log_id: qaId,
        source: "site",
        recruiter_email: email || null,
        recruiter_name: recruiterName || null,
        company: company || null,
        role_title: roleTitle || null,
        spec_text: spec,
        status: "new",
        delivery: cfg["default_delivery_mode"] ?? "draft",
      }),
    });
    return json({
      queued: true,
      scheduled: true,
      application: appRes.ok,
      email_captured: Boolean(email),
    }, 202);
  }

  // Live path: OpenAI-compatible provider (DeepSeek, Kimi/Moonshot, and similar).
  const apiKey = Deno.env.get("AI_API_KEY") ?? cfg["ai_api_key"];
  const baseUrl = (cfg["ai_base_url"] ?? "").replace(/\/$/, "");
  const liveConfigured = Boolean(apiKey && baseUrl && cfg["model"]);

  if (liveConfigured) {
    const system = cfg["sharing_rules"] ?? "";
    const facts = cfg["fact_base"] ?? "";
    let answer = "";
    let status = "ok";
    try {
      const aiRes = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg["model"],
          max_tokens: parseInt(cfg["max_answer_tokens"] || "400", 10),
          messages: [
            { role: "system", content: system },
            { role: "user", content: `FACTS:\n${facts}\n\nRecruiter question: ${question}` },
          ],
        }),
      });
      if (!aiRes.ok) {
        status = `ai_error_${aiRes.status}`;
      } else {
        const data = await aiRes.json();
        answer = (data.choices?.[0]?.message?.content ?? "").trim();
      }
    } catch (_e) {
      status = "ai_exception";
    }

    if (status === "ok" && answer) {
      await logRow({ ip_hash: ipHash, question, answer, status, asker_email: email || null });
      return json({ answer });
    }
    // Live path failed: fall through to the queue so the Cowork agents pick it up.
  }

  // Fallback: queue for the Cowork agents (hourly notifier + daily batch).
  await logRow({ ip_hash: ipHash, question, answer: null, status: "queued", asker_email: email || null });
  return json({ queued: true, email_captured: Boolean(email) }, 202);
});
