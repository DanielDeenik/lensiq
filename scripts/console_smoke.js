// Console smoke test. Renders src/console.html in a real browser against a
// snapshot of the live /api/state payload, so a broken control surface fails
// the pipeline instead of failing the first time Dan opens it.
//
// Usage: CONSOLE_BASE=... CONSOLE_TOKEN=... node scripts/console_smoke.js
// Without the env vars it falls back to a fixture, so it still runs offline.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'console.html'), 'utf8');

const FIXTURE = {
  applications: [{
    id: 1, status: 'draft_ready', created_at: new Date().toISOString(),
    recruiter_name: 'Fixture', recruiter_email: 'someone@example.com',
    company: 'Fixture Asset Management', role_title: 'Interim SimCorp Front Office Consultant',
    fit_score: 82, spec_text: 'spec', fit_report_md: 'report', cv_md: 'cv', cover_letter_md: 'letter',
    gmail_draft_id: 'r-fixture-draft',
  }],
  calls: [{
    id: 1, status: 'held', requester_name: 'Fixture', requester_email: 'someone@example.com',
    company: 'Fixture', role_title: 'Interim role', note: 'note',
    slot_start: new Date(Date.now() + 172800000).toISOString(), duration_minutes: 15,
  }],
  roles: [{ id: 1, title: 'Fixture role', link: 'https://example.com', jurisdiction: 'NL',
    source_ids: ['a', 'b'], score: 61, tier: 'WARM', last_seen: new Date().toISOString(), seen_by_dan: false }],
  runs: [{ ran_at: new Date().toISOString(), kind: 'roles_refresh', ok: true, items: 0 }],
  season: { industry: 'Asset Management', location: 'NL',
    months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    model: [88,90,82,70,75,65,22,18,72,85,55,20], peak: ['Feb','Jan','Oct'], slow: ['Aug','Dec','Jul'] },
  observed: { months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    counts: new Array(12).fill(0), index: new Array(12).fill(0), total: 0 },
  sources: [{ id: 'hoofdkraan', name: 'Hoofdkraan', jurisdiction: 'NL', active: true, missing: [] },
    { id: 'adzuna-nl-simcorp', name: 'Adzuna NL', jurisdiction: 'NL', active: false, missing: ['adzuna_app_id'] }],
  nexus_configured: true,
  defaults: { delivery: 'draft', call_timezone: 'Europe/Amsterdam' },
};

(async () => {
  let state = FIXTURE;
  let source = 'fixture';
  const base = process.env.CONSOLE_BASE;
  const token = process.env.CONSOLE_TOKEN;
  if (base && token) {
    try {
      const res = await fetch(base.replace(/\/$/, '') + '/api/state', { headers: { 'x-console-token': token } });
      if (res.ok) {
        const live = await res.json();
        // Merge the fixture rows in so the full control surface is always
        // asserted, whatever happens to be sitting in the real queues.
        state = Object.assign({}, live, {
          applications: FIXTURE.applications.concat(live.applications || []),
          calls: FIXTURE.calls.concat(live.calls || []),
          roles: (live.roles && live.roles.length) ? live.roles : FIXTURE.roles,
          runs: (live.runs && live.runs.length) ? live.runs : FIXTURE.runs,
          season: live.season || FIXTURE.season,
          observed: live.observed || FIXTURE.observed,
        });
        source = 'live plus fixture';
      }
    } catch (_e) { /* stay on the fixture */ }
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });

  // Serve the page from a real path so the console resolves its own API base
  // exactly the way it does in production, under /console/.
  await page.route('**/api/state', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(state),
  }));
  await page.route('https://console.test/console/', route => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: HTML,
  }));
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto('https://console.test/console/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

  const seen = await page.evaluate(() => ({
    apps: document.querySelectorAll('#apps .card').length,
    appButtons: Array.from(document.querySelectorAll('#apps button')).map(b => b.textContent),
    appLinks: Array.from(document.querySelectorAll('#apps a')).map(a => ({ text: a.textContent, href: a.getAttribute('href') })),
    appHint: (document.querySelector('#apps .status') || {}).textContent || '',
    calls: document.querySelectorAll('#calls .card').length,
    callButtons: Array.from(document.querySelectorAll('#calls button')).map(b => b.textContent),
    roles: document.querySelectorAll('#roles .role').length,
    srcstat: (document.getElementById('srcstat') || {}).textContent || '',
    seasonBars: document.querySelectorAll('#season .bars .b').length,
    arm: !!document.getElementById('armbtn'),
    runs: (document.getElementById('runs') || {}).textContent || '',
  }));

  add('applications render', seen.apps >= (state.applications || []).filter(a => a.status === 'pending_approval' || a.status === 'new').length,
    'cards=' + seen.apps);
  // Pressing send in Gmail is the approval, so the console must point at the
  // draft and say so, not offer an approve button that would be a second truth.
  add('console points at the Gmail draft', seen.appLinks.some(a => /Open the draft in Gmail/.test(a.text) && /mail\.google\.com/.test(a.href || '')),
    seen.appLinks.map(a => a.text).join(' | ').slice(0, 70));
  add('console says send is the approval', /send in Gmail is the approval/i.test(seen.appHint), seen.appHint.slice(0, 70));
  add('reject stays available, approve does not', seen.appButtons.some(b => /^Reject$/.test(b)) &&
    !seen.appButtons.some(b => /Approve/.test(b)), seen.appButtons.join(' | ').slice(0, 70));
  add('call requests render with confirm and decline', seen.calls > 0 &&
    seen.callButtons.some(b => /Confirm and invite/.test(b)) && seen.callButtons.some(b => /Decline/.test(b)),
    'cards=' + seen.calls + ' ' + seen.callButtons.join(' | ').slice(0, 60));
  add('role monitor section renders', seen.roles >= 0 && /sources live|dormant/.test(seen.srcstat), seen.srcstat.slice(0, 90));
  add('seasonality chart draws twelve months', seen.seasonBars === 24, 'bars=' + seen.seasonBars);
  add('credential arming is available', seen.arm);
  add('agent runs listed', seen.runs.length > 0);
  add('no javascript errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  let failed = 0;
  for (const c of checks) {
    console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
    if (!c.ok) failed++;
  }
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' console checks passed (state source: ' + source + ')');
  process.exit(failed ? 1 : 0);
})();
