#!/usr/bin/env node
// Quick smoke test: loads the terminal page and checks it's functional
const puppeteer = require('puppeteer');

const BASE = process.env.MOBUX_URL || 'https://localhost:5151';
const USER = process.env.MOBUX_USER || 'mvhenten';
const PASS = process.env.MOBUX_PASS || '30879';

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = await browser.newPage();

    // Basic auth
    const authHeader = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    await page.setExtraHTTPHeaders({ Authorization: authHeader });

    // 1. Check index loads
    console.log('  [1] Loading index...');
    const indexRes = await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 10000 });
    if (!indexRes.ok()) throw new Error(`Index returned ${indexRes.status()}`);
    const title = await page.title();
    if (!title.includes('Mobux')) throw new Error(`Unexpected title: ${title}`);
    console.log('  [1] ✓ Index loads, title:', title);

    // 2. Check API
    console.log('  [2] Checking sessions API...');
    const apiRes = await page.goto(`${BASE}/api/sessions`, { waitUntil: 'networkidle2', timeout: 5000 });
    if (!apiRes.ok()) throw new Error(`API returned ${apiRes.status()}`);
    const sessions = JSON.parse(await apiRes.text());
    console.log(`  [2] ✓ API works, ${sessions.length} sessions`);

    if (sessions.length === 0) {
      console.log('  [!] No sessions to test terminal page');
      process.exit(0);
    }

    // 3. Check terminal page loads and xterm renders
    const sess = sessions[0].name;
    console.log(`  [3] Loading terminal /s/${sess}...`);
    await page.goto(`${BASE}/s/${sess}`, { waitUntil: 'networkidle2', timeout: 10000 });

    // Wait for xterm to render
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });
    console.log('  [3] ✓ xterm rendered');

    // 4. Wait for loading screen to be removed (debounced reveal)
    await page.waitForFunction(() => !document.getElementById('loading'), { timeout: 5000 });
    console.log('  [4] ✓ Loading screen removed');

    // 5. Check touch overlay exists
    const hasOverlay = await page.$('#touchOverlay');
    if (!hasOverlay) throw new Error('Touch overlay missing!');
    console.log('  [5] ✓ Touch overlay present');

    // 6. Check WebSocket connected (terminal has content)
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.xterm-viewport');
      return viewport && viewport.scrollHeight > 100;
    }, { timeout: 5000 });
    console.log('  [6] ✓ Terminal has content (WebSocket connected)');

    console.log('\n  ✅ All checks passed');
    process.exit(0);
  } catch (e) {
    console.error('\n  ❌ FAILED:', e.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
