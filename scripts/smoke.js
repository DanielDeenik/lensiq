// Post-build smoke test. Runs against the built index.html in a real browser.
// Fails the pipeline on a blank render, a JS error, a lost section order,
// a chart that did not draw, or horizontal overflow on a phone viewport.
const path = require('path');
const { chromium } = require('playwright');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(FILE);
  await page.waitForTimeout(1500);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('section')).map(s => s.id).filter(Boolean));
  add('section order: analytics before fit', order.indexOf('analytics') < order.indexOf('fit'), order.join(' > '));

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
    return !p.hidden && p.textContent.trim().length > 20 && !p.querySelector('.sp-empty');
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

  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  add('no horizontal overflow at 400px', overflow === 0, 'overflow=' + overflow + 'px');

  add('no javascript errors', errors.length === 0, errors.join(' | '));

  await browser.close();

  let failed = 0;
  for (const c of checks) {
    console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
    if (!c.ok) failed++;
  }
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})();
