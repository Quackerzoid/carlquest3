/**
 * M7 browser acceptance (spec §9.7): two real Chromium pages against the live
 * dev servers (`npm run dev` — Vite on 5173, Colyseus on 2567), clicking through
 * the ENTIRE draft via the real card UI.
 *
 * Page 1 creates (side A), page 2 joins by the displayed code (side B). Each
 * page clicks ONLY on its own turn — it waits for its own draft heading to read
 * 'draft — your pick' and for enabled rows to exist, then clicks the first
 * enabled row (= first remaining roster id, so the draft is the deterministic
 * table-order one the scripted acceptance pins). Screenshots (written next to
 * this script, or to argv[2]):
 *   m7-01-mid-draft.png    — page 1's grid after 4 picks ([A]/[B] badges visible)
 *   m7-02-draft-complete.png — page 2 after completion: INITIAL_POSITIONING
 *                            status + the 'nominate bowler' strip, [bowling] on
 *                            kian (the grid itself is gone by design — the sheet
 *                            becomes the fielding side's pitcher strip)
 *   m7-03-pitcher-moved.png — page 2 after clicking Ricy: [bowling] mark moved
 * Every expectation throws on failure.
 *
 * Playwright is NOT a repo dependency (kept out of the workspaces on purpose).
 * To run: `npm i playwright` in a scratch dir (plus `npx playwright install
 * chromium` once), copy this file there, then
 * `node m7-browser-acceptance.mjs <output-dir>` — or point at the repo's
 * acceptance dir for the committed screenshots.
 */
import { chromium } from 'playwright';

// file:// URL pathnames on Windows come back as e.g. "/D:/..." (leading slash
// before the drive letter) — strip it so fs calls get a real Windows path.
const OUT = process.argv[2] ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const URL_APP = 'http://localhost:5173';
const log = (m) => console.log(m);
const assert = (cond, what) => {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`OK: ${what}`);
};

const EXPECT_PICKS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy'];

const browser = await chromium.launch();
const ctx1 = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page1 = await ctx1.newPage(); // creator → side A
const page2 = await ctx2.newPage(); // joiner → side B

await page1.goto(URL_APP);
await page2.goto(URL_APP);

// Create + join by the code read from page 1's DOM (the M6 flow).
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
log(`page 1 created match; displayed code = ${code}`);
assert(/^[A-Z]{4}$/.test(code), `4-letter room code displayed (got '${code}')`);
await page2.fill('#join-code', code);
await page2.click('#lobby-join');

// Both pages must reach the DRAFT phase with the pick grid showing.
for (const [i, page] of [page1, page2].entries()) {
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent?.startsWith('DRAFT') ?? false,
    { timeout: 20000 },
  );
  await page.waitForSelector('#draft:not([hidden])', { timeout: 5000 });
  log(`page ${i + 1} reached DRAFT with the pick grid visible`);
}

// Click through the ENTIRE draft: each page acts only on its own turn, which it
// reads from its own DOM (heading 'draft — your pick' + enabled rows present).
const clicked = [];
for (let pick = 0; pick < EXPECT_PICKS.length; pick += 1) {
  const page = pick % 2 === 0 ? page1 : page2; // A first, strict alternation
  const who = pick % 2 === 0 ? 'A(page1)' : 'B(page2)';
  await page.waitForFunction(
    () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'draft — your pick',
    { timeout: 15000 },
  );
  const row = page.locator('#draft .draft-row:not([disabled])').first();
  const id = await row.getAttribute('data-id');
  await row.click();
  clicked.push(id);
  log(`pick ${pick + 1}: ${who} clicked ${id}`);
  // Wait for the pick to land: the clicked row badges up — or, on the FINAL
  // pick, the draft completes and the phase leaves DRAFT before any badge can
  // render (the sheet flips to pitcher/hidden mode in the same state patch).
  await page.waitForFunction(
    (pickedId) => {
      const badge = document.querySelector(`#draft .draft-row[data-id="${pickedId}"] .draft-row-badge`);
      const status = document.querySelector('#status')?.textContent ?? '';
      return (badge !== null && badge.textContent !== '') || !status.startsWith('DRAFT');
    },
    id,
    { timeout: 10000 },
  );
  if (pick === 3) {
    await page1.screenshot({ path: `${OUT}/m7-01-mid-draft.png` });
    const badged = await page1.locator('#draft .draft-row-badge').allTextContents();
    const nonEmpty = badged.filter((b) => b !== '');
    assert(nonEmpty.length === 4, `mid-draft screenshot shows 4 badged cards (got ${nonEmpty.length}: ${nonEmpty.join(' ')})`);
  }
}
assert(JSON.stringify(clicked) === JSON.stringify(EXPECT_PICKS), `table-order draft clicked through the UI (${clicked.join(',')})`);

// Draft complete: both pages reach INITIAL_POSITIONING; the batting page's
// sheet hides, the fielding page's sheet becomes the pitcher strip.
for (const [i, page] of [page1, page2].entries()) {
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent?.startsWith('INITIAL_POSITIONING') ?? false,
    { timeout: 20000 },
  );
  log(`page ${i + 1} reached INITIAL_POSITIONING`);
}
assert(await page1.locator('#draft').isHidden(), 'batting page (A) no longer shows the draft sheet');
await page2.waitForFunction(
  () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'nominate bowler',
  { timeout: 10000 },
);
const kianBadge = await page2.textContent('#draft .draft-row[data-id="kian"] .draft-row-badge');
assert(kianBadge === '[bowling]', `default bowler kian carries the [bowling] mark (got '${kianBadge}')`);
const visibleRows = await page2.locator('#draft .draft-row:not([hidden])').evaluateAll((rows) => rows.map((r) => r.dataset.id).sort());
assert(JSON.stringify(visibleRows) === JSON.stringify(['darcy', 'josh', 'kian', 'ricy', 'robbie']), `pitcher strip shows only B's squad (${visibleRows.join(',')})`);
await page2.screenshot({ path: `${OUT}/m7-02-draft-complete.png` });

// The fielding page nominates a different pitcher by clicking its strip.
await page2.click('#draft .draft-row[data-id="ricy"]');
await page2.waitForFunction(
  () => document.querySelector('#draft .draft-row[data-id="ricy"] .draft-row-badge')?.textContent === '[bowling]',
  { timeout: 10000 },
);
const kianAfter = await page2.textContent('#draft .draft-row[data-id="kian"] .draft-row-badge');
assert(kianAfter === '', `the [bowling] mark left kian (got '${kianAfter}')`);
const status2 = (await page2.textContent('#status')) ?? '';
assert(status2.includes('bowler: Ricy'), `page 2 status line names the new bowler (got '${status2.split('\n')[0]}')`);
await page2.screenshot({ path: `${OUT}/m7-03-pitcher-moved.png` });

log('BROWSER ACCEPTANCE PASSED');
await browser.close();
