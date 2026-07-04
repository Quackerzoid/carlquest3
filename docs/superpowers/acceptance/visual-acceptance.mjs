/**
 * Visual-overhaul browser acceptance: two real Chromium pages in separate
 * contexts against the live dev servers (`npm run dev` — Vite on 5173,
 * Colyseus on 2567), proving the overhauled look end-to-end through the real UI:
 *
 *  1. Create/join by code, then a CUSTOM draft clicked through the sheet that
 *     puts the extremes of the roster — the 3.1 m whale AND the 1.3 m joe — on
 *     side B, so both are FIELDED together in innings 1 (the whale is only ever
 *     rendered on the field if drafted). A: carl,laurie,josh,joel,darcy;
 *     B: kian,whale,joe,robbie,ricy (kian = B's default bowler, pitch 8,
 *     earliest pick). jonty stays undrafted.
 *  2. ANTI-PILL / DISTINCTNESS (the overhaul's core claim): page 2 (side B,
 *     fielding) panel-selects whale, single ground click at (16, 26) — ONE
 *     click only: Task 3 lerps per animation frame, so the old m8 7-click
 *     convergence burst is obsolete — then joe to (0, 23) (whale slightly
 *     DEEPER, so perspective only shrinks him). Each figure's rendered VERTICAL PIXEL
 *     EXTENT is measured by diffing before/after screenshots in a window
 *     around the target's projection through a Node-side replica of the
 *     client camera (fov 55, pos (0,12,−14), lookAt (2,0,10) — SceneModule).
 *     Asserted: whaleExtent ≥ 1.6 × joeExtent, and joe is actually present.
 *     This doubles as the PICKING REGRESSION check (m8 flow: panel row select
 *     → computed ground click → the figure renders at the target; [selected]
 *     badge asserted; old-slot vacancy logged).
 *  3. STADIUM PRESENCE: the upper half of page 1's frame must not be the old
 *     flat backdrop — distinct quantised colour count (stands + 3k crowd +
 *     floodlights + gradient sky) asserted well above what any flat sky/green
 *     could produce, plus a blue-ish sky sample at the very top.
 *  4. Play with real keydowns (Enter gates, A/S/D+P pitch, Space swing, m10
 *     retry pattern for missed swings): first connected hit → screenshot
 *     visual-02-lineup.png with BOTH KITS live (navy kit-A runner + maroon
 *     kit-B fielders). NOTE (deviation from the brief's 'positioning phase'
 *     wording, logged honestly): the batting side is never rendered during
 *     INITIAL_POSITIONING — runners only exist server-side once a hit
 *     connects — so the both-kits lineup shot is necessarily mid-play.
 *  5. HOLDER GOLD RING (Task-3 reviewer ask), via a deterministic HOLDER DRILL:
 *     the first play's opening pitch is deliberately NOT swung at — the ball
 *     rolls past the batter, the nearest fielder gathers it and, with no runner
 *     exposed to throw at, HOLDS it, lighting the gold ring (emissive 0xd9a441
 *     renders as exactly (217,164,65) with the diffuse zeroed) close to the
 *     camera where the flat ring is several pixels thick. The watch window is a
 *     bottom-centre field patch free of HUD text and of every gold confound
 *     (earlier runs proved: HUD gold's antialiased edges, laurie's blond quiff
 *     and carl's armband all pollute a whole-frame gold-band count, while at
 *     30 m+ the ring itself antialiases into the grass — hence a close-range
 *     drill in a clean window instead). Capture frame → visual-03-play.png,
 *     then the new-gold centroid is located and logged as evidence.
 *  6. OUT-RUNNER TOPPLE (best-effort, m10 pattern): on an out-carrying
 *     resolution, red-tinted (emissive 0xbb3333) pixels vs a pre-game
 *     baseline; logged honestly if no out lands in view within the play budget.
 *  7. Zero page/console errors on both pages throughout.
 *
 * Screenshots (written to argv[2], or next to this script):
 *   visual-01-stadium.png — wide stadium shot at INITIAL_POSITIONING
 *   visual-02-lineup.png  — mid-play: navy runner + maroon fielders (both kits)
 *   visual-03-play.png    — mid-play: fielder holding the ball, gold ring lit
 * Every expectation throws (exit non-zero).
 *
 * Playwright/pngjs/three are NOT repo dependencies. To run: `npm i playwright
 * pngjs three` in a scratch dir (plus `npx playwright install chromium` once),
 * copy this file there, then `node visual-acceptance.mjs <output-dir>`.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import * as THREE from 'three';

const OUT = process.argv[2] ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const URL_APP = 'http://localhost:5173';
const W = 1100;
const H = 700;
const T0 = Date.now();
const WATCHDOG_MS = 9 * 60 * 1000;
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const assert = (cond, what) => {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`OK: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checkWatchdog = () => {
  if (Date.now() - T0 > WATCHDOG_MS) throw new Error('WATCHDOG: acceptance exceeded 9 minutes');
};

// Custom draft: whale AND joe both onto side B (fields innings 1). A first, strict alternation.
const PICKS = ['carl', 'kian', 'laurie', 'whale', 'josh', 'joe', 'joel', 'robbie', 'darcy', 'ricy'];
// Anti-pill measurement spots: near-equal depth (whale 3 m deeper = conservatively SMALLER),
// inside LEGAL_ZONE, ≥3 m from the batting square, and their projection windows clear of the
// occupied default slots, the posts/pennants, the top-right draft sheet and the HUD boxes
// (world −x projects screen-RIGHT under the top-right sheet — hence both spots sit at +x/centre).
const SPOT_WHALE = { x: 16, z: 26 };
const SPOT_JOE = { x: 0, z: 23 };
const MEASURE_TOP_M = 3.6; // window ceiling above the tallest figure (whale 3.1 m)
const RESOLUTION_RE = /caught by |run out at post |safe at post |rounder!/;

/** Node-side replica of SceneModule's camera; world → CSS-pixel projection. */
function projectToPixel(x, y, z) {
  const cam = new THREE.PerspectiveCamera(55, W / H, 0.1, 500);
  cam.position.set(0, 12, -14);
  cam.lookAt(new THREE.Vector3(2, 0, 10));
  cam.updateMatrixWorld();
  const v = new THREE.Vector3(x, y, z).project(cam);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

/** Rendered vertical pixel extent of whatever CHANGED between two frames in a column window. */
function changedExtent(before, after, spot) {
  const top = Math.max(0, Math.round(projectToPixel(spot.x, MEASURE_TOP_M, spot.z).y) - 6);
  const bottom = Math.min(H - 1, Math.round(projectToPixel(spot.x, 0, spot.z).y) + 8);
  const cx = Math.round(projectToPixel(spot.x, 0, spot.z).x);
  const halfW = 34;
  let firstRow = -1;
  let lastRow = -1;
  let changedPx = 0;
  for (let y = top; y <= bottom; y += 1) {
    let rowChanged = 0;
    for (let x = Math.max(0, cx - halfW); x <= Math.min(W - 1, cx + halfW); x += 1) {
      const i = (W * y + x) * 4;
      const d = Math.abs(before.data[i] - after.data[i])
        + Math.abs(before.data[i + 1] - after.data[i + 1])
        + Math.abs(before.data[i + 2] - after.data[i + 2]);
      if (d > 45) rowChanged += 1;
    }
    if (rowChanged >= 3) {
      if (firstRow < 0) firstRow = y;
      lastRow = y;
      changedPx += rowChanged;
    }
  }
  return { extent: firstRow < 0 ? 0 : lastRow - firstRow + 1, changedPx, window: { cx, top, bottom } };
}

/** Holder-ring gold: emissive 0xd9a441 renders EXACTLY (217,164,65). Tight matcher so the
 *  post pennants (216,165,49 — basic material) and HUD gold #f5c542 never count. */
/**
 * Counted ONLY inside the field region, excluding every HUD rectangle: the top-left
 * board+feed (x<280), the bottom legend strip (y>640) and the top-right sheet (x>770,
 * y<340). HUD gold (#f5c542 badges/keys) misses the band, but its ANTIALIASED edges
 * fall inside it, and HUD content CHANGES between baseline and play (a lit legend,
 * a [PRESSURE] badge) — run 3 of this harness caught exactly that false positive.
 */
function countHolderGold(png) {
  let n = 0;
  let near = 0;
  for (let y = 10; y <= 640; y += 1) {
    for (let x = 280; x < W; x += 1) {
      if (x > 770 && y < 340) continue;
      const i = (W * y + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r >= 211 && r <= 223 && g >= 158 && g <= 170 && b >= 59 && b <= 71) n += 1;
      else if (r >= 195 && r <= 240 && g >= 140 && g <= 190 && b >= 55 && b <= 95) near += 1;
    }
  }
  return { exact: n, near };
}

/** Out-tint red (emissive 0xbb3333 over the figure — saturated bright red). */
function countToppleRed(png) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (r > 170 && r > 2 * g && r > 2 * b) n += 1;
  }
  return n;
}

/** Distinct quantised colours (5-bit/channel) in the upper half — stadium richness. */
function distinctUpperColours(png) {
  const seen = new Set();
  for (let y = 0; y < Math.floor(H / 2); y += 1) {
    for (let x = 0; x < W; x += 2) {
      const i = (W * y + x) * 4;
      seen.add(((png.data[i] >> 3) << 10) | ((png.data[i + 1] >> 3) << 5) | (png.data[i + 2] >> 3));
    }
  }
  return seen.size;
}

const shot = async (page) => PNG.sync.read(await page.screenshot());

const browser = await chromium.launch();
const errors = { 1: [], 2: [] };
const mkPage = async (n) => {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[n].push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors[n].push(`console.error: ${msg.text()}`);
  });
  return page;
};
const page1 = await mkPage(1); // creator → side A (bats innings 1, NAVY kit)
const page2 = await mkPage(2); // joiner → side B (fields innings 1, MAROON kit)
const pages = [page1, page2];

await page1.goto(URL_APP);
await page2.goto(URL_APP);

// ===================== 1. Create + join + CUSTOM draft (whale & joe onto B) =====================
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
assert(/^[A-Z]{4}$/.test(code), `4-letter room code displayed (got '${code}')`);
await page2.fill('#join-code', code);
await page2.click('#lobby-join');

for (const [i, page] of pages.entries()) {
  await page.waitForSelector('#draft:not([hidden])', { timeout: 20000 });
  await page.evaluate(() => document.activeElement?.blur());
  log(`page ${i + 1} reached DRAFT with the pick sheet visible`);
}

for (let pick = 0; pick < PICKS.length; pick += 1) {
  const page = pick % 2 === 0 ? page1 : page2; // A first, strict alternation
  await page.waitForFunction(
    () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'draft — your pick',
    { timeout: 15000 },
  );
  const id = PICKS[pick];
  await page.click(`#draft .draft-row[data-id="${id}"]:not([disabled])`);
  await page.waitForFunction(
    (pickedId) => {
      const badge = document.querySelector(`#draft .draft-row[data-id="${pickedId}"] .draft-row-badge`);
      const phase = document.querySelector('#board-phase')?.textContent ?? '';
      return (badge !== null && badge.textContent !== '') || phase !== 'draft';
    },
    id,
    { timeout: 10000 },
  );
}
log(`custom draft clicked through the UI: ${PICKS.join(',')} (whale + joe on side B)`);

for (const [i, page] of pages.entries()) {
  await page.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent === 'initial positioning',
    { timeout: 20000 },
  );
  await page.evaluate(() => document.activeElement?.blur());
  log(`page ${i + 1} board shows phase 'initial positioning'`);
}

// ===================== 2. Stadium presence (page 1, wide shot) =====================
await sleep(600); // let the models settle/build after the draft patch
const stadiumPng = await shot(page1);
writeFileSync(`${OUT}/visual-01-stadium.png`, PNG.sync.write(stadiumPng));
log('visual-01-stadium.png written');

const skyTop = (() => {
  const i = (W * 4 + Math.floor(W / 2)) * 4;
  return [stadiumPng.data[i], stadiumPng.data[i + 1], stadiumPng.data[i + 2]];
})();
// New sky = warm late-afternoon gradient dome (SceneModule: horizon gold #f6dcae → zenith
// blue); the OLD backdrop was flat overcast blue 0x87b5d9 (135,181,217 — b-dominant).
assert(
  skyTop[0] > skyTop[2] + 25,
  `sky sample at frame top is the warm gradient, not the old flat overcast blue (rgb ${skyTop.join(',')} vs old 135,181,217)`,
);
const distinct = distinctUpperColours(stadiumPng);
assert(
  distinct >= 60,
  `upper half of the frame carries stadium richness — ${distinct} distinct quantised colours (a flat sky/green backdrop yields <10)`,
);

// ===================== 3. Anti-pill + picking regression (page 2, fielding B) =====================
await page2.waitForFunction(
  () => document.querySelector('#draft .draft-sheet-heading')?.textContent?.startsWith('positioning') ?? false,
  { timeout: 10000 },
);
const beforePng = await shot(page2);

/** Panel-select a fielder, single ground click at the spot, wait for the per-frame lerp to converge. */
async function repositionTo(id, spot) {
  await page2.click(`#draft .draft-row[data-id="${id}"]`);
  const p = projectToPixel(spot.x, 0, spot.z);
  await page2.mouse.click(p.x, p.y);
  await page2.waitForFunction(
    (rowId) => document.querySelector(`#draft .draft-row[data-id="${rowId}"] .draft-row-badge`)?.textContent === '[selected]',
    id,
    { timeout: 10000 },
  );
  await sleep(1800); // Task-3 per-frame lerp converges without extra patches (single click, no m8 burst)
  await page2.evaluate(() => document.activeElement?.blur());
  await page2.keyboard.press('Escape'); // clear the selection ring so it never pads the measurement
  await sleep(300);
  log(`page 2 panel-selected ${id} ([selected] badge shown) and ground-clicked (${spot.x}, ${spot.z}) — single click`);
}

await repositionTo('whale', SPOT_WHALE);
await repositionTo('joe', SPOT_JOE);
const afterPng = await shot(page2);

const whale = changedExtent(beforePng, afterPng, SPOT_WHALE);
const joe = changedExtent(beforePng, afterPng, SPOT_JOE);
log(`whale rendered vertical extent at (${SPOT_WHALE.x}, ${SPOT_WHALE.z}): ${whale.extent}px (${whale.changedPx} changed px; window x=${whale.window.cx} y=${whale.window.top}..${whale.window.bottom})`);
log(`joe rendered vertical extent at (${SPOT_JOE.x}, ${SPOT_JOE.z}): ${joe.extent}px (${joe.changedPx} changed px; window x=${joe.window.cx} y=${joe.window.top}..${joe.window.bottom})`);
assert(whale.changedPx >= 60, `picking regression: whale's figure renders at the clicked spot (${whale.changedPx} changed px — schema reposition + render both moved)`);
assert(joe.changedPx >= 25, `picking regression: joe's figure renders at the clicked spot (${joe.changedPx} changed px)`);
assert(joe.extent >= 8, `joe is present and measurable (${joe.extent}px tall)`);
const ratio = whale.extent / joe.extent;
assert(ratio >= 1.6, `ANTI-PILL: whale's rendered height is ≥1.6× joe's at equal depth (ratio ${ratio.toFixed(2)} — whale ${whale.extent}px vs joe ${joe.extent}px; world 3.1 m vs 1.3 m)`);
const oldWhaleSlot = changedExtent(beforePng, afterPng, { x: 0, z: -3 }); // whale's default slot (pick order slot 1)
log(`whale's old slot (0, -3) also changed (vacated): ${oldWhaleSlot.changedPx} changed px`);

// ===================== 4–6. Play: both kits, holder gold ring, topple (best-effort) =====================
const baselineRed = countToppleRed(afterPng);
const goldBase = countHolderGold(afterPng);
log(`baselines (pre-play): topple-red ${baselineRed} px, holder-gold ${goldBase.exact} exact + ${goldBase.near} near-band px (field region)`);

const phaseOf = async (page) => (await page.textContent('#board-phase'))?.trim() ?? '';
async function advanceToPlay() {
  const start = Date.now();
  for (;;) {
    checkWatchdog();
    const ph = await phaseOf(page1);
    if (ph === 'play' || ph === 'game over') return ph;
    if (ph === 'initial positioning' || ph === 'pre play') {
      await page1.keyboard.press('Enter');
      await page2.keyboard.press('Enter');
    }
    if (Date.now() - start > 20000) throw new Error(`stuck advancing to PLAY (phase '${ph}')`);
    await sleep(250);
  }
}
async function currentRoles() {
  const you1 = (await page1.textContent('#board-you')) ?? '';
  return you1.includes('batting') ? { bat: page1, field: page2 } : { bat: page2, field: page1 };
}

let holderGold = null; // { px, exact, play }
let lineupDone = false;
let topple = 'no out occurred on-screen within the play budget — topple unverified (best-effort, logged honestly)';
let toppleVerified = false;
let plays = 0;
const MAX_PLAYS = 10;

/**
 * HOLDER DRILL window: the bottom-centre field patch around the batting square /
 * bowling spot, clear of every HUD box and of every gold confound. A pitch that is
 * deliberately NOT swung at rolls past the batter; the nearest fielder walks in,
 * gathers, and — with no runner exposed to throw at — HOLDS the ball, lighting the
 * gold ring at close camera range (~20 m, where the ring is several px thick).
 * In-window inks: grass, chalk, kian (maroon/cream/SKIN_LIGHT/dark cap — none in
 * the gold band) and the red ball (fails g>b+40). Whale and joe were repositioned
 * out of the window (z ≥ 23) by the anti-pill step; no runner exists on a miss.
 */
const DRILL_WIN = { x0: 350, x1: 760, y0: 350, y1: 640 };
function countDrillGold(png) {
  let n = 0;
  for (let y = DRILL_WIN.y0; y <= DRILL_WIN.y1; y += 1) {
    for (let x = DRILL_WIN.x0; x <= DRILL_WIN.x1; x += 1) {
      const i = (W * y + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r >= 195 && r <= 240 && g >= 140 && g <= 190 && b >= 55 && b <= 95) n += 1;
    }
  }
  return n;
}

for (; plays < MAX_PLAYS; ) {
  checkWatchdog();
  const ph = await advanceToPlay();
  if (ph === 'game over') break;
  await Promise.all(pages.map((p) => p.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent === 'play',
    { timeout: 10000 },
  )));
  const roles = await currentRoles();
  await page1.evaluate(() => {
    for (const e of document.querySelectorAll('#hud-feed .feed-entry')) e.dataset.seen = '1';
  });
  const spinKeys = ['s', 'a', 'd'];
  let resolved = false;

  // ---- Holder drill (first play only): pitch, do NOT swing, watch the ring light up.
  if (plays === 0 && holderGold === null) {
    const drillBase = countDrillGold(await shot(page1));
    log(`holder drill: window baseline ${drillBase} gold-band px — pitching with NO swing`);
    await roles.field.keyboard.press('s');
    await roles.field.keyboard.press('p');
    const drillUntil = Date.now() + 8500;
    let drillMax = 0;
    while (Date.now() < drillUntil && holderGold === null) {
      const png = await shot(page1);
      const n = countDrillGold(png);
      if (n > drillMax) drillMax = n;
      if (n - drillBase >= 20) {
        holderGold = { px: n - drillBase, exact: countHolderGold(png).exact, play: 1 };
        writeFileSync(`${OUT}/visual-03-play.png`, PNG.sync.write(png));
        log(`HOLDER GOLD RING captured live (drill): +${holderGold.px} gold-band px in the drill window (${holderGold.exact} exact-emissive px frame-wide) → visual-03-play.png`);
      } else {
        await sleep(90);
      }
    }
    if (holderGold === null) log(`holder drill: ring NOT seen (window max ${drillMax} vs baseline ${drillBase}) — will keep watching later plays`);
  }

  for (let attempt = 0; attempt < 8 && !resolved; attempt += 1) {
    await roles.field.keyboard.press(spinKeys[(plays + attempt) % 3]);
    await roles.field.keyboard.press('p');
    await sleep(240 + ((plays + attempt) % 4) * 45);
    await roles.bat.keyboard.press(' ');
    // Poll the frame while the play unfolds: drill-window ring watch + both-kits lineup shot.
    const pollUntil = Date.now() + 7000;
    let resolvedLine = false;
    while (Date.now() < pollUntil && !resolvedLine) {
      const png = await shot(page1);
      resolvedLine = await page1.evaluate((re) => [...document.querySelectorAll('#hud-feed .feed-entry')]
        .some((e) => !e.dataset.seen && new RegExp(re).test(e.textContent ?? '')), RESOLUTION_RE.source);
      if (holderGold === null) {
        const n = countDrillGold(png);
        if (n >= 20) {
          holderGold = { px: n, exact: countHolderGold(png).exact, play: plays + 1 };
          writeFileSync(`${OUT}/visual-03-play.png`, PNG.sync.write(png));
          log(`HOLDER GOLD RING captured live on play ${plays + 1}: ${holderGold.px} gold-band px in the drill window → visual-03-play.png`);
        }
      }
      if (!lineupDone && !resolvedLine) {
        // A runner exists once the swing connects; keep the latest mid-play frame
        // before the resolution as the both-kits lineup shot candidate.
        writeFileSync(`${OUT}/visual-02-lineup.png`, PNG.sync.write(png));
      }
      if (!resolvedLine) await sleep(90);
    }
    resolved = resolvedLine;
    if (!resolved) log(`play ${plays + 1}: no resolution (swing likely missed → silent re-pitch) — attempt ${attempt + 2}`);
  }
  if (!resolved) throw new Error(`play ${plays + 1}: no resolution after 8 pitch/swing attempts`);
  const line = await page1.evaluate((re) => {
    const hit = [...document.querySelectorAll('#hud-feed .feed-entry')]
      .find((e) => !e.dataset.seen && new RegExp(re).test(e.textContent ?? ''));
    return hit?.textContent ?? '';
  }, RESOLUTION_RE.source);
  plays += 1;
  log(`play ${plays}: ${line}`);
  if (/safe at post|rounder!|run out/.test(line)) lineupDone = true; // a runner ran → the saved frame shows both kits
  if (!toppleVerified && /caught by |run out at post /.test(line)) {
    const png = await shot(page1);
    const red = countToppleRed(png);
    if (red - baselineRed >= 100) {
      toppleVerified = true;
      topple = `VERIFIED: red-tinted toppled runner after '${line}' (${red} red px vs baseline ${baselineRed})`;
    } else {
      topple = `NOT CAPTURED (last out-carrying play '${line}': ${red} red px vs baseline ${baselineRed})`;
    }
    log(`out-runner topple attempt: ${topple}`);
  }
  await page1.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent !== 'play',
    { timeout: 10000 },
  );
  if (holderGold !== null && lineupDone && (toppleVerified || plays >= 6)) break;
}

assert(plays >= 1, `at least one play resolved via real keydowns (${plays} plays driven)`);
assert(lineupDone, 'a connected hit produced a running navy batter among maroon fielders (visual-02-lineup.png shows both kits)');
if (holderGold !== null) {
  // Locate the captured cluster (delta vs the pre-play frame) so the evidence log
  // records WHERE the gold appeared — a feet ring sits at a fielder position, not HUD.
  const capPng = PNG.sync.read(await import('node:fs').then((fs) => fs.readFileSync(`${OUT}/visual-03-play.png`)));
  const inBand = (d, i) => d[i] >= 195 && d[i] <= 240 && d[i + 1] >= 140 && d[i + 1] <= 190 && d[i + 2] >= 55 && d[i + 2] <= 95;
  let sx = 0;
  let sy = 0;
  let sn = 0;
  for (let y = 10; y <= 640; y += 1) {
    for (let x = 280; x < W; x += 1) {
      if (x > 770 && y < 340) continue;
      const i = (W * y + x) * 4;
      if (inBand(capPng.data, i) && !inBand(afterPng.data, i)) {
        sx += x;
        sy += y;
        sn += 1;
      }
    }
  }
  log(`holder gold ring: VERIFIED live (play ${holderGold.play}, +${holderGold.px} gold-band px in the field region, ${holderGold.exact} exact; new-gold centroid (${(sx / sn).toFixed(0)}, ${(sy / sn).toFixed(0)}) of ${sn} px)`);
} else {
  log('holder gold ring: NOT captured within the play budget (honest best-effort log — no frame showed the exact emissive gold cluster)');
}
assert(holderGold !== null, 'holder gold ring captured live (Task-3 reviewer ask)');
log(`out-runner topple (best-effort): ${topple}`);

// ===================== 7. Error hygiene =====================
for (const n of [1, 2]) {
  assert(errors[n].length === 0, `page ${n} logged no page/console errors (${errors[n].join(' ;; ')})`);
}

log(`VISUAL ACCEPTANCE PASSED — ${plays} plays; anti-pill ratio ${ratio.toFixed(2)}; holder ring ${holderGold ? 'captured' : 'missed'}; stadium colours ${distinct}`);
await browser.close();
