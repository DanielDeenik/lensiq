// Post-build smoke test. Runs against the built index.html in a real browser.
// Fails the pipeline on a blank render, a JS error, a lost section order,
// a chart that did not draw, or horizontal overflow on a phone viewport.
const path = require('path');
const { chromium } = require('playwright');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // The booking widget reads live slots from the edge function. The headless
  // browser has no route to it, so the widget is exercised against a fixture
  // here and the real endpoint is checked over the network further down.
  await page.route('**/functions/v1/site/slots', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      timezone: 'Europe/Amsterdam',
      window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' },
      durations: [{ id: 'qualifier', minutes: 15, label: '15 minute quick qualifier' }],
      location: 'Google Meet',
      calendar_synced: false,
      slots: [
        { start: '2026-09-16T07:00:00.000Z', end: '2026-09-16T07:15:00.000Z', date: '2026-09-16', day: 'Wed 16/09', time: '09:00' },
        { start: '2026-09-16T07:15:00.000Z', end: '2026-09-16T07:30:00.000Z', date: '2026-09-16', day: 'Wed 16/09', time: '09:15' },
        { start: '2026-09-17T07:00:00.000Z', end: '2026-09-17T07:15:00.000Z', date: '2026-09-17', day: 'Thu 17/09', time: '09:00' }
      ]
    })
  }));
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(FILE);
  await page.waitForTimeout(1500);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('section')).map(s => s.id).filter(Boolean));
  add('section order: fit before analytics', order.indexOf('fit') < order.indexOf('analytics'), order.join(' > '));

  add('sankey rendered', await page.evaluate(() => !!document.querySelector('#sankey svg path')));
  add('gantt rendered', await page.evaluate(() => document.querySelectorAll('#gantt .grow').length > 0));
  add('career arc rendered', await page.evaluate(() => !!document.querySelector('#arc svg path')));
  add('coverage matrix rendered', await page.evaluate(() => document.querySelectorAll('.matrix .mc.on').length > 0));
  add('radars rendered', await page.evaluate(() =>
    !!document.querySelector('#platradar svg') && !!document.querySelector('#domradar svg')));
  add('detail panel present', await page.evaluate(() => !!document.getElementById('anapanel')));

  // clicking a chart block must fill the right-hand panel
  add('chart click fills panel', await page.evaluate(() => {
    const r = document.querySelectorAll('#sankey svg rect');
    if (!r.length) return false;
    r[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const p = document.getElementById('anapanel');
    return !p.hidden && p.querySelectorAll('.sp-row').length >= 2 && !p.querySelector('.sp-empty');
  }));

  // fit check must score a spec and show provenance
  await page.fill('#specin', 'SimCorp Dimension consultant, ESG and SFDR, IBOR, FIX connectivity, Python, front office order management.');
  await page.evaluate(() => document.getElementById('fitbtn').click());
  await page.waitForTimeout(400);
  const fit = await page.evaluate(() => ({
    pct: (document.getElementById('fitpct') || {}).textContent,
    rows: document.querySelectorAll('#fitexpo .expo-row').length,
    radar: document.querySelectorAll('#fitradar svg *').length
  }));
  add('fit check scores', /\d+%/.test(fit.pct || ''), 'pct=' + fit.pct);
  add('fit exposure rows', fit.rows > 0, 'rows=' + fit.rows);
  add('fit radar drawn', fit.radar > 10, 'els=' + fit.radar);

  // The fit check must weigh depth, not first match. A spec built on Dan's core
  // has to outscore one built on the tools that merely support his delivery.
  const scoreFor = async (text) => {
    await page.fill('#specin', text);
    await page.evaluate(() => document.getElementById('fitbtn').click());
    await page.waitForTimeout(300);
    return page.evaluate(() => ({
      pct: parseInt((document.getElementById('fitpct') || {}).textContent || '0', 10),
      summary: (document.getElementById('fitsum') || {}).textContent || '',
      headings: Array.from(document.querySelectorAll('#fitmatch h4')).map(h => h.textContent),
    }));
  };
  const core = await scoreFor('SimCorp Dimension front office consultant. Order Manager, IBOR and position keeping, Compliance Manager rules, Alternative Investment Manager, security setup and valuations, FIX connectivity to Bloomberg.');
  const periph = await scoreFor('SimCorp Communication Server specialist. Build and maintain Communication Server jobs, batch jobs and job scheduling. Axioma risk model calibration, factor model validation and quantitative model development. Monte Carlo experience required.');
  add('core spec outscores a peripheral one', core.pct > periph.pct + 15,
    'core=' + core.pct + '% peripheral=' + periph.pct + '%');
  add('peripheral spec is called out honestly',
    /thins out/i.test(periph.summary) || periph.headings.some(h => /thins out/i.test(h)),
    'summary=' + periph.summary.slice(0, 90));
  add('core spec names what he leads on',
    core.headings.some(h => /leads on/i.test(h)), core.headings.join(' | ').slice(0, 90));
  add('comm server is shown as support, not headline', periph.headings.some(h => /Supports his delivery/i.test(h)) || /communication server/i.test(periph.summary),
    periph.headings.join(' | ').slice(0, 90));
  await page.fill('#specin', 'SimCorp Dimension consultant, ESG and SFDR, IBOR, FIX connectivity, Python, front office order management.');
  await page.evaluate(() => document.getElementById('fitbtn').click());
  await page.waitForTimeout(300);

  // Booking widget: the section, the live slot grid and the form fields.
  add('book a call section present', await page.evaluate(() =>
    !!document.getElementById('call') && !!document.getElementById('slotdays')));
  add('recruiter fields on the fit form', await page.evaluate(() =>
    ['fitname', 'fitcompany', 'fitrole', 'fitemail'].every(id => !!document.getElementById(id))));
  const slots = await page.evaluate(() => ({
    buttons: document.querySelectorAll('#slotdays .slotbtn').length,
    days: document.querySelectorAll('#slotdays .slotday').length,
    meta: (document.getElementById('slotmeta') || {}).textContent || '',
  }));
  add('slot grid renders days and times', slots.buttons === 3 && slots.days === 2,
    'buttons=' + slots.buttons + ' days=' + slots.days);
  add('slot grid states the call terms', /15 minute/.test(slots.meta) && /Amsterdam/.test(slots.meta), slots.meta.slice(0, 70));
  add('slot selection updates the choice line', await page.evaluate(() => {
    const b = document.querySelector('#slotdays .slotbtn');
    if (!b) return false;
    b.click();
    const p = document.getElementById('slotpick');
    return !p.hidden && /Chosen:/.test(p.textContent);
  }));

  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  add('no horizontal overflow at 400px', overflow === 0, 'overflow=' + overflow + 'px');

  add('no javascript errors', errors.length === 0, errors.join(' | '));

  await browser.close();

  // Live endpoint check. Uses the process proxy and CA like every other tool,
  // so a broken deploy fails the pipeline rather than hiding behind a fixture.
  const live = await (async () => {
    const base = process.env.SITE_FN_URL || 'https://hvitxwhfdhsdwhgllaqf.supabase.co/functions/v1/site';
    try {
      const res = await fetch(base + '/slots');
      if (!res.ok) return { ok: false, detail: 'http ' + res.status };
      const data = await res.json();
      const n = Array.isArray(data.slots) ? data.slots.length : 0;
      return { ok: n > 0 && !!data.timezone, detail: n + ' open slots, tz ' + data.timezone };
    } catch (e) {
      return { ok: false, detail: 'unreachable: ' + e.message };
    }
  })();
  add('live slots endpoint answers', live.ok, live.detail);

  let failed = 0;
  for (const c of checks) {
    console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
    if (!c.ok) failed++;
  }
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})();
