/**
 * M8 browser acceptance (spec §9.8): two real Chromium pages against the live
 * dev servers (`npm run dev` — Vite on 5173, Colyseus on 2567), clicking through
 * the ENTIRE draft via the real card UI (the M7 helper), then exercising the M8
 * positioning UI:
 *
 *  - Page 2 (side B, fielding): selects a non-pitcher fielder (josh) via its
 *    PANEL row (the row shares the single selection store with the 3D raycast
 *    path), then clicks a GROUND pixel on the canvas. The pixel is computed by
 *    projecting a known legal field point, T = (−8, 24), through a Node-side
 *    replica of the client camera (three.js: fov 55, pos (0,12,−14), lookAt
 *    (2,0,10) — SceneModule.ts). The moved capsule is verified by sampling
 *    screenshot pixels at T's projection for the capsule's blue (0x3b6ea5)
 *    against the green ground, before (absent) and after (present).
 *    NOTE — client render smoothing: RenderModule lerps a capsule 50% towards
 *    the authoritative position PER STATE PATCH, and during positioning no
 *    further patches arrive after a single reposition, so one click leaves the
 *    capsule visually midway. The script therefore clicks a short convergence
 *    burst (7 clicks, tiny offsets, last one exactly T) — each accepted
 *    reposition is a real schema move and a real patch. Logged in CLAUDE.md
 *    §6.4 as a known (cosmetic) issue.
 *  - Panel assertions: 'bench — awaiting roster growth' empty-bench row and
 *    the 'subs used: 0' heading (five-a-side squads, nine slots → no bench).
 *  - Page 1 (side A, batting): clicks a queue row (Joe) and the status line
 *    announces the new batter; the displaced Carl re-renders at the queue head.
 *
 * Screenshots (written next to this script, or to argv[2]):
 *   m8-01-positioning-panel.png — page 2's panel: empty-bench note + subs count
 *   m8-02-fielder-moved.png     — page 2 after the reposition: [selected] badge
 *                                 on josh + the capsule out at (−8, 24)
 *   m8-03-next-batter.png       — page 1 after the queue click: batter: Joe
 * Every expectation throws on failure.
 *
 * Playwright/three/pngjs are NOT repo dependencies (kept out of the workspaces
 * on purpose). To run: `npm i playwright three pngjs` in a scratch dir (plus
 * `npx playwright install chromium` once), copy this file there, then
 * `node m8-browser-acceptance.mjs <output-dir>`.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import * as THREE from 'three';

// file:// URL pathnames on Windows come back as e.g. "/D:/..." (leading slash
// before the drive letter) — strip it so fs calls get a real Windows path.
const OUT = process.argv[2] ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const URL_APP = 'http://localhost:5173';
const W = 1100;
const H = 700;
const log = (m) => console.log(m);
const assert = (cond, what) => {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`OK: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECT_PICKS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy'];
/** Reposition target: inside LEGAL_ZONE, ≥3 m from the batting square, clear of every capsule/post projection and the fixed panel/status overlays. */
const T = { x: -8, z: 24 };
const HUMAN_EYE_HEIGHT = 1.05; // RenderModule capsule centre height

/** Node-side replica of SceneModule's camera; world → CSS-pixel projection. */
function projectToPixel(x, y, z) {
  const cam = new THREE.PerspectiveCamera(55, W / H, 0.1, 500);
  cam.position.set(0, 12, -14);
  cam.lookAt(new THREE.Vector3(2, 0, 10));
  cam.updateMatrixWorld();
  const v = new THREE.Vector3(x, y, z).project(cam);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

/** Count "capsule blue" pixels (0x3b6ea5 under Lambert light: blue clearly dominant) in a square window. */
function countBluish(png, cx, cy, half) {
  let n = 0;
  for (let y = Math.max(0, Math.round(cy - half)); y < Math.min(png.height, Math.round(cy + half)); y += 1) {
    for (let x = Math.max(0, Math.round(cx - half)); x < Math.min(png.width, Math.round(cx + half)); x += 1) {
      const i = (png.width * y + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (b > r + 25 && b > g + 15) n += 1;
    }
  }
  return n;
}

async function bluishAt(page, worldX, worldZ, half = 15) {
  const p = projectToPixel(worldX, HUMAN_EYE_HEIGHT, worldZ);
  const png = PNG.sync.read(await page.screenshot());
  return countBluish(png, p.x, p.y, half);
}

const browser = await chromium.launch();
const ctx1 = await browser.newContext({ viewport: { width: W, height: H } });
const ctx2 = await browser.newContext({ viewport: { width: W, height: H } });
const page1 = await ctx1.newPage(); // creator → side A (bats innings 1)
const page2 = await ctx2.newPage(); // joiner → side B (fields innings 1)

await page1.goto(URL_APP);
await page2.goto(URL_APP);

// ===================== Create + join + full draft (the M7 click-through) =====================
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
log(`page 1 created match; displayed code = ${code}`);
assert(/^[A-Z]{4}$/.test(code), `4-letter room code displayed (got '${code}')`);
await page2.fill('#join-code', code);
await page2.click('#lobby-join');

for (const [i, page] of [page1, page2].entries()) {
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent?.startsWith('DRAFT') ?? false,
    { timeout: 20000 },
  );
  await page.waitForSelector('#draft:not([hidden])', { timeout: 5000 });
  log(`page ${i + 1} reached DRAFT with the pick grid visible`);
}

const clicked = [];
for (let pick = 0; pick < EXPECT_PICKS.length; pick += 1) {
  const page = pick % 2 === 0 ? page1 : page2; // A first, strict alternation
  await page.waitForFunction(
    () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'draft — your pick',
    { timeout: 15000 },
  );
  const row = page.locator('#draft .draft-row:not([disabled])').first();
  const id = await row.getAttribute('data-id');
  await row.click();
  clicked.push(id);
  await page.waitForFunction(
    (pickedId) => {
      const badge = document.querySelector(`#draft .draft-row[data-id="${pickedId}"] .draft-row-badge`);
      const status = document.querySelector('#status')?.textContent ?? '';
      return (badge !== null && badge.textContent !== '') || !status.startsWith('DRAFT');
    },
    id,
    { timeout: 10000 },
  );
}
assert(JSON.stringify(clicked) === JSON.stringify(EXPECT_PICKS), `table-order draft clicked through the UI (${clicked.join(',')})`);

for (const [i, page] of [page1, page2].entries()) {
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent?.startsWith('INITIAL_POSITIONING') ?? false,
    { timeout: 20000 },
  );
  log(`page ${i + 1} reached INITIAL_POSITIONING`);
}

// ===================== Page 2 (fielding B): panel — empty bench + subs count =====================
await page2.waitForFunction(
  () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'positioning — subs used: 0',
  { timeout: 10000 },
);
log('page 2 panel heading = positioning — subs used: 0');
const benchRows = await page2.locator('#draft .draft-row-name').allTextContents();
assert(
  benchRows.includes('bench — awaiting roster growth'),
  `empty bench shows exactly 'bench — awaiting roster growth' (rows: ${benchRows.join(' | ')})`,
);
const bowlerBadge = await page2.textContent('#draft .draft-row[data-id="kian"] .draft-row-badge');
assert(bowlerBadge === '[bowling]', `default bowler kian carries the [bowling] mark (got '${bowlerBadge}')`);
await page2.screenshot({ path: `${OUT}/m8-01-positioning-panel.png` });

// ===================== Page 2: panel-select josh, canvas ground click, capsule moves =====================
// Sanity: no capsule blue at T before the move (green ground there).
const beforeCount = await bluishAt(page2, T.x, T.z);
assert(beforeCount < 5, `no capsule at (${T.x}, ${T.z}) before the move (${beforeCount} bluish px)`);

// Select via the PANEL row (shares the selection store with the 3D raycast path).
await page2.click(`#draft .draft-row[data-id="josh"]`);
log('page 2 selected josh via its panel row');

// Ground clicks: a short convergence burst (see header — the render lerp moves the
// capsule 50% per patch, and positioning phases only patch when state changes).
const offsets = [
  [0.4, 0], [0, 0.4], [0.3, 0.3], [0.2, 0], [0, 0.2], [0.1, 0.1], [0, 0],
];
for (const [dx, dz] of offsets) {
  const p = projectToPixel(T.x + dx, 0, T.z + dz);
  await page2.mouse.click(p.x, p.y);
  await sleep(180); // let the reposition round-trip and its patch lerp the capsule
}
log(`page 2 clicked the ground at the projection of (${T.x}, ${T.z}) (7-click convergence burst)`);

// The [selected] badge renders once a patch arrives (the reposition provides one).
await page2.waitForFunction(
  () => document.querySelector('#draft .draft-row[data-id="josh"] .draft-row-badge')?.textContent === '[selected]',
  { timeout: 10000 },
);
log('josh panel row shows the [selected] badge');

const afterCount = await bluishAt(page2, T.x, T.z);
assert(afterCount >= 10, `josh's capsule rendered at (${T.x}, ${T.z}) after the reposition (${afterCount} bluish px, was ${beforeCount})`);
const oldSpot = await bluishAt(page2, 0, -3); // josh's default slot (0, −3)
log(`bluish px remaining at josh's old slot (0, -3): ${oldSpot}`);
await page2.screenshot({ path: `${OUT}/m8-02-fielder-moved.png` });

// ===================== Page 1 (batting A): queue click announces the new batter =====================
await page1.waitForFunction(
  () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'next batter',
  { timeout: 10000 },
);
const status1 = (await page1.textContent('#status')) ?? '';
assert(status1.includes('batter: Carl'), `page 1 status names the default first batter (got '${status1.split('\n')[0]}')`);
const queueBefore = await page1.locator('#draft .draft-row').evaluateAll((rows) => rows.map((r) => r.dataset.id));
assert(
  JSON.stringify(queueBefore) === JSON.stringify(['laurie', 'joel', 'jonty', 'joe']),
  `queue rows are laurie,joel,jonty,joe (got ${queueBefore.join(',')})`,
);

await page1.click('#draft .draft-row[data-id="joe"]');
await page1.waitForFunction(
  () => (document.querySelector('#status')?.textContent ?? '').includes('batter: Joe'),
  { timeout: 10000 },
);
log('page 1 status line announces the new batter: Joe');
const queueAfter = await page1.locator('#draft .draft-row').evaluateAll((rows) => rows.map((r) => r.dataset.id));
assert(queueAfter[0] === 'carl', `displaced carl re-renders at the queue head (got ${queueAfter.join(',')})`);
await page1.screenshot({ path: `${OUT}/m8-03-next-batter.png` });

log('BROWSER ACCEPTANCE PASSED');
await browser.close();
