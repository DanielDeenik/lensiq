// LensIQ intake. The site's three forms (question, job spec, call request) post here.
// Each submission becomes one email in Dan's Gmail. Gmail is the queue; the hourly
// scheduled agent reads it, prepares drafts and invitations, and labels it done.
// No database. Everything else is served from ./dist as static assets.
import { EmailMessage } from "cloudflare:email";

const FROM = "intake@lensiq.company";
const TO = "deenikdaniel@gmail.com";
const ORIGINS = ["https://lensiq.company", "https://www.lensiq.company", "https://danieldeenik.github.io"];
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return ORIGINS.includes(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" }
    : {};
}
function json(req, body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
}
function clean(v, max) {
  return typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "";
}
function oneLine(v) { return v.replace(/[\n\t]+/g, " ").trim(); }
function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function wrap(s) { return s.replace(/.{1,76}/g, "$&\r\n"); }

export function classify(p) {
  if (p.spec) return "spec";
  if (p.question.startsWith("Call request") || (p.call_preference && !p.spec && p.question.startsWith("Call"))) return "call";
  return "question";
}

export function buildMessage(p, kind, now) {
  const who = p.name || p.company || p.email || "anonymous visitor";
  const subj = {
    spec: "LensIQ spec: " + (p.role || "role not given") + (p.company ? " at " + p.company : "") + " from " + who,
    call: "LensIQ call: " + who + (p.role ? " about " + p.role : ""),
    question: "LensIQ question: " + p.question.slice(0, 80),
  }[kind];
  const lines = [
    "Kind: " + kind,
    "Received: " + now.toISOString(),
    "Name: " + (p.name || "-"),
    "Email: " + (p.email || "-"),
    "Company: " + (p.company || "-"),
    "Role: " + (p.role || "-"),
    "Call preference: " + (p.call_preference || "-"),
    "",
    "Question or subject line from the site:",
    p.question || "-",
  ];
  if (p.spec) lines.push("", "FULL SPEC:", p.spec);
  lines.push("", "---LENSIQ-JSON---", JSON.stringify({ kind, received: now.toISOString(), ...p }), "---END---");
  const headers = [
    "From: LensIQ intake <" + FROM + ">",
    "To: " + TO,
    ...(p.email ? ["Reply-To: " + p.email] : []),
    "Subject: =?UTF-8?B?" + b64(oneLine(subj)) + "?=",
    "Date: " + now.toUTCString(),
    "Message-ID: <" + crypto.randomUUID() + "@lensiq.company>",
    "X-LensIQ-Kind: " + kind,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return { subject: subj, raw: headers.join("\r\n") + "\r\n\r\n" + wrap(b64(lines.join("\n"))) };
}

async function intake(req, env) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > 24000) return json(req, { error: "too_large" }, 413);
  let body;
  try { body = await req.json(); } catch { return json(req, { error: "bad_json" }, 400); }
  const p = {
    question: clean(body.question, 300),
    email: clean(body.email, 200),
    name: oneLine(clean(body.name, 120)),
    company: oneLine(clean(body.company, 120)),
    role: oneLine(clean(body.role, 160)),
    call_preference: clean(body.call_preference, 300),
    spec: clean(body.spec, 8000),
  };
  if (p.email && !EMAIL_RE.test(p.email)) p.email = "";
  if (!p.question && !p.spec) return json(req, { error: "empty" }, 400);
  const kind = classify(p);
  if (kind === "call" && !p.email) return json(req, { error: "email_required" }, 400);
  const { raw } = buildMessage(p, kind, new Date());
  try {
    await env.INTAKE.send(new EmailMessage(FROM, TO, raw));
  } catch (e) {
    return json(req, { error: "send_failed" }, 503);
  }
  return json(req, { queued: true, requested: kind === "call", email_captured: Boolean(p.email), kind }, 202);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/site" || url.pathname === "/api/site/") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (req.method === "POST") return intake(req, env);
      return json(req, { error: "method" }, 405);
    }
    if (url.pathname.startsWith("/api/")) return json(req, { error: "not_found" }, 404);
    return env.ASSETS.fetch(req);
  },
};
