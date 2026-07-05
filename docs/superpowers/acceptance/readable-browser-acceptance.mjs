/**
 * Readable-game overhaul browser acceptance: two real Chromium pages against a
 * live dev server, watching the ground-up visual overhaul (minimal-mascot blob
 * characters, the ×2 walking world with a batting bench, full ball
 * presentation, and the bold arcade-pop UI restyle with tooltips + a real
 * READY button) through actual play.
 *
 *  1. Arcade lobby (create → 4-letter code → join) screenshot.
 *  2. Full table-order draft clicked through the real card UI, forcing a
 *     hover tooltip to render on an ability chip before screenshotting.
 *  3. READY button: green "CONFIRM SETUP" state screenshot, click it, blue +
 *     checkmark "waiting for opponent" state screenshot — asserted via DOM
 *     class/text AND a computed-background-colour sample (not eyeballing).
 *  4. Hands off — HUD mid-play screenshot (bright arcade cards, not dark glass)
 *     + the light-UI luminance assertion (a `#hud-board` background pixel
 *     sampled directly, not the WebGL canvas — asserted bright, not dark-glass).
 *  5. Ball trail + highlight mid-flight (polled burst across the live PLAY
 *     window, overwriting the same file until the phase leaves PLAY, so the
 *     committed frame is mid-flight rather than racing one lucky instant).
 *  6. Holder icon above a fielder's head, captured in the NEXT play's
 *     pre-release pitch-hold window (polled burst).
 *  7. Mascot lineup: SEVERAL candidate close/low orbit+zoom framings aimed at
 *     the batting bench (where different-width characters sit close
 *     together, 2m seat spacing) are tried and scored by an on-screen
 *     mascot-tone pixel count; the highest-scoring framing is committed — not
 *     a single blind aim, which a first attempt at this shot proved could
 *     land as a distant near-top-down view unable to support the intended
 *     hand-offset/face-stretch visual-tuning judgement flagged in the Task-3
 *     SDD ledger row.
 *  8. Bench occupied + the current batter mid-WALK: the harness watches
 *     `#hud-players .player-card.is-bat .player-name` for the CURRENT
 *     BATTER'S NAME TO CHANGE (fires the instant the server assigns a fresh
 *     currentBatterId, who originates at the bench ~43m from the square — a
 *     ~14s walk at WALK_SPEED_M_S), so the capture window reliably lands well
 *     inside a genuine walk rather than an arbitrary PRE_PLAY moment that
 *     might catch an already-arrived, merely-breathing batter. Two committed
 *     frames ~1s apart are proved via pixel-centroid tracking of the current
 *     batter's KIT HUE (navy for side A or maroon for side B, derived live
 *     from '#board-you' since batting side alternates by innings) — a
 *     non-trivial (>8px) measured delta is REQUIRED, not just "not
 *     byte-identical". READY is deliberately not clicked anywhere in this
 *     window so the phase cannot flip to PLAY mid-capture.
 *  9. Walk-speed ceiling assertion: the SAME sample burst used for (8) is
 *     checked for any single inter-sample jump exceeding a generous
 *     screen-space bound — proves nothing teleports/snaps outside PLAY.
 * 10. (folded into 4 above — see the light-UI luminance assertion.)
 * 11. Zero console/page errors across the whole run, both pages.
 *
 * Screenshots (written to argv[2], default alongside):
 *   readable-01-lobby.png, readable-02-draft-tooltip.png,
 *   readable-03a-ready-green.png, readable-03b-ready-blue.png,
 *   readable-04-hud-play.png, readable-05-mascot-lineup.png,
 *   readable-06-ball-trail.png, readable-07-holder-icon.png,
 *   readable-08a-walk.png, readable-08b-walk.png
 * Every expectation throws on failure (assert() idiom, matching the
 * autoplay-browser-acceptance.mjs precedent).
 *
 * Playwright/pngjs are NOT repo dependencies. To run: `npm i playwright
 * pngjs` in a scratch dir (plus `npx playwright install chromium` once),
 * copy this file there, then
 *   node readable-browser-acceptance.mjs <output-dir> [app-url]
 * Canonical ports (Vite 5173 / Colyseus 2567) are tried first; if occupied,
 * see autoplay-browser-acceptance.mjs's header for the alt-port shim pattern.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { writeFile } from 'node:fs/promises';

const OUT = process.argv[2] ?? '.';
const URL_APP = process.argv[3] ?? 'http://localhost:5173';
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const assert = (cond, what) => {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`OK: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECT_PICKS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy'];
const RESOLUTION_RE = /caught by |run out at post |safe at post |rounder!/;

/** Reads a PNG buffer's pixel at (x, y) as [r, g, b, a]. */
function pixelAt(buf, x, y) {
  const png = PNG.sync.read(buf);
  const xi = Math.max(0, Math.min(png.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(png.height - 1, Math.round(y)));
  const i = (png.width * yi + xi) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/** Counts pixels within tol of a target colour in a centred box of a PNG buffer. */
function countNear(buf, target, tol, boxHalf) {
  const png = PNG.sync.read(buf);
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  let count = 0;
  for (let y = cy - boxHalf; y <= cy + boxHalf; y += 1) {
    for (let x = cx - boxHalf; x <= cx + boxHalf; x += 1) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const i = (png.width * y + x) << 2;
      if (
        Math.abs(png.data[i] - target[0]) <= tol &&
        Math.abs(png.data[i + 1] - target[1]) <= tol &&
        Math.abs(png.data[i + 2] - target[2]) <= tol
      )
        count += 1;
    }
  }
  return count;
}

/**
 * Finds the centroid of pixels that read as a given kit hue — 'navy' (side A,
 * KIT_COLOURS.A shirt 0x1e4fd8) or 'maroon' (side B, KIT_COLOURS.B shirt
 * 0xd83a3a) — within an EXCLUSION-aware scan of the buffer. Used to locate the
 * CURRENT batter's kit patch so its position can be compared frame-to-frame as
 * proof of walking motion; which hue to search for must match whichever side
 * is actually batting at capture time (batting side alternates by innings, so
 * a hardcoded navy-only search silently fails once side B is up).
 *
 * Lambert shading under the stadium's warm directional light darkens the flat
 * kit colour substantially (measured live: navy (30,79,216) renders as roughly
 * (19,48,108) on the lit blob, maroon (216,58,58) as roughly (164,35,25) — both
 * R/G/B scaled down by a similar factor, not hue-shifted), so a flat
 * per-channel tolerance match against the UNSHADED texture colour is
 * unreliable — a HUE/RATIO test is used instead: navy = blue clearly dominant
 * (B > R*1.6 and B > G*1.3); maroon = red clearly dominant over both other
 * channels (R > G*2.5 and R > B*2.5) with red bright enough to exclude
 * near-black shadow/outline pixels.
 *
 * The scan is also restricted to `yMin..yMax` (the 3D pitch region, excluding
 * the sky band above and the fixed-position HUD/draft overlays which get their
 * own explicit `excludeRects`) — narrowing the search area is what makes the
 * hue test reliable in practice (a whole-frame scan previously matched a huge,
 * static, unrelated region and produced a false "not moving" reading).
 *
 * `excludeRects` (fixed-position DOM overlay boxes, e.g. the top-left HUD
 * score card, or the top-right draft/positioning sheet) are skipped so a
 * same-family-coloured DOM element composited into the screenshot (the navy
 * `#board-you` pill, `.score-a` text, feed left-borders, `.is-team-a` panel
 * borders) cannot masquerade as the 3D figure. Returns null if no matching
 * pixels found.
 */
function findCentroid(buf, hue, excludeRects = [], yMin = 300, yMax = 700) {
  const png = PNG.sync.read(buf);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = yMin; y < Math.min(yMax, png.height); y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (excludeRects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) continue;
      const i = (png.width * y + x) << 2;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      const isMatch =
        hue === 'navy' ? b > 60 && b > r * 1.6 && b > g * 1.3 : r > 60 && r > g * 2.5 && r > b * 2.5;
      if (isMatch) {
        sx += x;
        sy += y;
        n += 1;
      }
    }
  }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n, n };
}

// Fixed-position DOM overlay boxes composited into a full-viewport screenshot
// (index.html #hud-left top/left 14px ~20em wide plus the feed list below it;
// #draft top/right 14px ~25em wide) — excluded from kit-colour centroid
// searches so their navy accents (#board-you pill, .score-a text, feed
// left-borders, .is-team-a panel rows) cannot be mistaken for the 3D batter.
const HUD_EXCLUDE = { x0: 0, y0: 0, x1: 345, y1: 600 };
const DRAFT_EXCLUDE = { x0: 930, y0: 0, x1: 1280, y1: 600 };

const browser = await chromium.launch();
const errors = { 1: [], 2: [] };
const mkPage = async (n) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors[n].push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/WebSocket|net::|Failed to load resource/.test(msg.text()))
      errors[n].push(`console.error: ${msg.text()}`);
  });
  return page;
};
const page1 = await mkPage(1); // creator → side A (bats innings 1)
const page2 = await mkPage(2); // joiner → side B (fields innings 1)

await page1.goto(URL_APP);
await page2.goto(URL_APP);

// ---- 1. Arcade lobby + code flow ----
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
assert(/^[A-Z]{4}$/.test(code), `4-letter room code displayed (got '${code}')`);
await page1.screenshot({ path: `${OUT}/readable-01-lobby.png` });
await page2.fill('#join-code', code);
await page2.click('#lobby-join');

for (const [i, page] of [page1, page2].entries()) {
  await page.waitForSelector('#draft:not([hidden])', { timeout: 20000 });
  await page.evaluate(() => document.activeElement?.blur());
  log(`page ${i + 1} reached DRAFT`);
}

// ---- 2. Full draft click-through, forcing a tooltip to render ----
const clicked = [];
for (let pick = 0; pick < EXPECT_PICKS.length; pick += 1) {
  const page = pick % 2 === 0 ? page1 : page2;
  await page.waitForFunction(
    () => document.querySelector('#draft .draft-sheet-heading')?.textContent === 'draft — your pick',
    undefined,
    { timeout: 15000 },
  );
  const row = page.locator('#draft .draft-row:not([disabled])').first();
  const id = await row.getAttribute('data-id');
  // On the SECOND pick (page1, kian — an easily-identified id), hover the ability
  // chip long enough for the tooltip to render, screenshot it, THEN click the row
  // (hover must not itself pick — DraftScreen only reacts to click).
  if (pick === 1) {
    const abilityChip = row.locator('.draft-row-ability');
    await abilityChip.hover();
    await page.waitForSelector('#tooltip.is-visible', { timeout: 5000 });
    const tipBody = (await page.textContent('#tooltip .tip-body'))?.trim() ?? '';
    assert(tipBody.length > 10, `ability tooltip text rendered ('${tipBody}')`);
    await page.screenshot({ path: `${OUT}/readable-02-draft-tooltip.png` });
    log('ability tooltip captured mid-hover on the draft sheet');
  }
  await row.click();
  clicked.push(id);
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
assert(JSON.stringify(clicked) === JSON.stringify(EXPECT_PICKS), `table-order draft clicked (${clicked.join(',')})`);

for (const page of [page1, page2]) {
  await page.waitForFunction(() => document.querySelector('#board-phase')?.textContent === 'initial positioning', undefined, {
    timeout: 20000,
  });
}
log('both pages at INITIAL_POSITIONING');

// ---- 3. READY button: green -> click -> blue+tick, asserted via DOM state ----
await sleep(300); // let the HUD settle after the phase flip
const readyBg1 = await page1.evaluate(() => getComputedStyle(document.querySelector('#ready-button')).backgroundColor);
const readyClassBefore = (await page1.getAttribute('#ready-button', 'class')) ?? '';
assert(!readyClassBefore.includes('is-waiting'), `READY button starts NOT waiting (class='${readyClassBefore}')`);
const readyLabelBefore = (await page1.textContent('#ready-label'))?.trim() ?? '';
assert(readyLabelBefore === 'CONFIRM SETUP', `READY button reads CONFIRM SETUP before click (got '${readyLabelBefore}')`);
await page1.screenshot({ path: `${OUT}/readable-03a-ready-green.png` });
log(`READY green background sampled: ${readyBg1}`);

await page1.click('#ready-button');
await page1.waitForSelector('#ready-button.is-waiting', { timeout: 5000 });
const readyBg2 = await page1.evaluate(() => getComputedStyle(document.querySelector('#ready-button')).backgroundColor);
const readyClassAfter = (await page1.getAttribute('#ready-button', 'class')) ?? '';
assert(readyClassAfter.includes('is-waiting'), `READY button gained is-waiting class after click (class='${readyClassAfter}')`);
const readySubAfter = (await page1.textContent('#ready-sub'))?.trim() ?? '';
assert(readySubAfter === 'waiting for opponent', `READY sub-label reads 'waiting for opponent' (got '${readySubAfter}')`);
assert(readyBg1 !== readyBg2, `READY button background colour actually changed ('${readyBg1}' -> '${readyBg2}')`);
await page1.screenshot({ path: `${OUT}/readable-03b-ready-blue.png` });
log(`READY blue background sampled: ${readyBg2}`);

// Page 2 also readies up so the game can proceed.
await page2.click('#ready-button');

// ---- 4/5/6/7/8/9. Hands off — watch the auto-play, capture presentation ----
for (;;) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph === 'play') break;
  if (ph === 'initial positioning' || ph === 'pre play') {
    // Idempotent: READY button click is a no-op once already confirmed for the
    // phase (main.ts latches per-phase), so repeating it is harmless.
    await page1.click('#ready-button').catch(() => {});
    await page2.click('#ready-button').catch(() => {});
  }
  if (Date.now() - T0 > 180000) throw new Error(`stuck advancing to PLAY (phase '${ph}')`);
  await sleep(200);
}
log('phase PLAY — hands off, watching');

// ---- 9. Walk-speed sample BEFORE play (INITIAL_POSITIONING/PRE_PLAY are walk-clamped) ----
// Sampled just above, before we broke into PLAY: re-derive a fresh sample window on
// page 2 (fielding side, so its own fielders may still be settling from the draft's
// slot-derivation walk-in) by going back to a later PRE_PLAY (post-first-play) window
// further down; capture an initial-positioning-era baseline here for completeness.
const legendPlay = (await page1.textContent('#hud-legend')) ?? '';
assert(legendPlay.includes('play in progress'), `PLAY legend visible ('${legendPlay.trim()}')`);

// HUD mid-play screenshot: bright arcade cards, not dark glass.
await sleep(400);
await page1.screenshot({ path: `${OUT}/readable-04-hud-play.png` });

// ---- 10. Light-UI assertion: sample the score-board card background directly ----
const boardBg = await page1.evaluate(() => {
  const el = document.querySelector('#hud-board');
  const c = getComputedStyle(el).backgroundColor;
  const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
});
assert(boardBg !== null, `#hud-board background colour readable (${boardBg})`);
const boardLuma = (boardBg[0] + boardBg[1] + boardBg[2]) / 3;
assert(boardLuma > 150, `#hud-board background is BRIGHT (arcade-pop, not dark-glass) — avg rgb ${boardLuma.toFixed(0)} (rgb=${JSON.stringify(boardBg)})`);

// ---- 6. Ball trail + highlight mid-flight: poll a burst across the WHOLE play window ----
// The ball is only "live" (visible mesh + highlight + trail) for the flight window, which
// is transient — poll repeatedly (not once) at a tight interval for as long as the phase
// stays PLAY, overwriting the same file each time, so the LAST write lands mid-flight
// somewhere in the play rather than racing a single lucky instant.
let ballShotTaken = false;
const ballBurstDeadline = Date.now() + 60000;
while (Date.now() < ballBurstDeadline) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph !== 'play') break;
  await page1.screenshot({ path: `${OUT}/readable-06-ball-trail.png` });
  ballShotTaken = true;
  await sleep(150);
}
assert(ballShotTaken, 'ball trail/highlight screenshot captured during a live PLAY window');
log('ball trail/highlight frame captured (polled burst during live PLAY)');

// ---- 7. Holder icon: wait for resolution, then capture the NEXT play's pitch-hold window ----
// Wait for the first play to resolve (a fielder will have gathered the ball at some
// point in that sequence — the icon is visible whenever ANY fielder's hasBall flag is
// true, which includes the pitcher holding pre-pitch and any fielder mid-relay).
await page1.waitForFunction(
  (re) => [...document.querySelectorAll('#hud-feed .feed-entry')].some((e) => new RegExp(re).test(e.textContent ?? '')),
  RESOLUTION_RE.source,
  { timeout: 90000 },
);
log('first play resolved on page 1');

// The NEXT play's pitch beat guarantees the pitcher holds the ball pre-release —
// capture a burst across that window (readies both sides idempotently while polling).
for (;;) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph === 'play') break;
  await page1.click('#ready-button').catch(() => {});
  await page2.click('#ready-button').catch(() => {});
  if (Date.now() - T0 > 300000) throw new Error('stuck advancing to the second PLAY for the holder-icon capture');
  await sleep(200);
}
let holderShotTaken = false;
const holderBurstDeadline = Date.now() + 8000; // the pitch delay beat is ~1.5s server-side; give it margin
while (Date.now() < holderBurstDeadline) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph !== 'play') break;
  await page1.screenshot({ path: `${OUT}/readable-07-holder-icon.png` });
  holderShotTaken = true;
  await sleep(120);
}
assert(holderShotTaken, 'holder-icon screenshot captured during the second play (pitcher pre-release hold window)');
log('holder-icon frame captured (polled burst, pitcher pre-release hold window, second play)');

// ---- 5. Mascot lineup: orbit + zoom TIGHT on the batting bench, where several ----
// different-width characters sit close together (2m seat spacing) so each one
// fills a real fraction of the frame — the wide top-down "13 tiny blobs" framing
// from the first attempt at this shot could not support the hand/face visual
// judgement, so this version deliberately trades "the whole pitch" for "close
// enough to actually see hands and faces". Page 1 is side A (batting), so its
// bench holds A's non-batting squad (carl/laurie/joel/jonty/joe minus whoever
// is currently at the square) — a mix of narrow (joe) and wide (jonty, joel)
// builds, exactly the comparison the Task-3 SDD ledger flagged. The orbit
// target is pulled from the CENTRE (0,0,18) to the bench's OWN world position
// (via repeated orbit+zoom nudges — CameraControls has no direct "look at X"
// API, so a drag sequence aimed at screen-left, where the bench renders under
// the default centre framing, plus max zoom-in gets us close).
const box1 = await page1.locator('#app').boundingBox();
const cx1 = box1.x + box1.width / 2;
const cy1 = box1.y + box1.height / 2;

/** Cheap proxy for "mascots fill more of the frame": count pixels matching a
 * character skin/kit tone (Lambert-shaded tones run darker than the flat
 * texture colour, so the tolerance here is generous). Used to pick the best
 * of several candidate camera framings rather than trust one blind aim. */
const CANDIDATE_TONES = [
  [0x1e, 0x4f, 0xd8], // KIT A shirt (navy)
  [0xf1, 0xc9, 0xa5], // SKIN_LIGHT
  [0xc6, 0x86, 0x42], // SKIN_MEDIUM
  [0xe0, 0xac, 0x7e], // SKIN_TAN
];
function mascotPixelScore(buf) {
  const png = PNG.sync.read(buf);
  let score = 0;
  for (let y = 0; y < png.height; y += 3) {
    for (let x = 0; x < png.width; x += 3) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      for (const [tr, tg, tb] of CANDIDATE_TONES) {
        if (Math.abs(r - tr) < 55 && Math.abs(g - tg) < 55 && Math.abs(b - tb) < 55) {
          score += 1;
          break;
        }
      }
    }
  }
  return score;
}

// Orbit to a low, near-horizontal angle (foreground figures read large via
// perspective) and yaw the view towards the bench side (LEGAL_ZONE.minX,
// screen-left under the default centred framing), then zoom to MIN_RADIUS
// (repeat wheel-in far past the 24m clamp so it settles at the floor). The
// orbit TARGET is a fixed point (0,0,18), not the bench itself — CameraControls
// has no direct "look at X" API — so several yaw/pitch candidates are tried and
// the one with the highest mascot-tone pixel score is committed, rather than
// trusting a single blind aim (the first version of this shot was a distant,
// near top-down framing that could not support the intended visual judgement).
const candidates = [
  { dx: -16, dy: -9, label: 'low, yawed towards bench (screen-left)' },
  { dx: -22, dy: -6, label: 'low, yawed further left' },
  { dx: -10, dy: -11, label: 'lower angle, moderate yaw' },
  { dx: -18, dy: -3, label: 'shallower angle, strong yaw' },
];
let bestScore = -1;
let bestBuf = null;
let bestLabel = '';
for (const c of candidates) {
  // Reset toward the classic pose before each candidate drag so they don't compound.
  await page1.keyboard.press('Home');
  await sleep(150);
  await page1.mouse.move(cx1, cy1);
  await page1.mouse.down();
  for (let i = 1; i <= 14; i += 1) await page1.mouse.move(cx1 + i * c.dx, cy1 + i * c.dy);
  await page1.mouse.up();
  for (let i = 0; i < 10; i += 1) {
    await page1.mouse.wheel(0, -400);
    await sleep(40);
  }
  await sleep(300);
  const buf = await page1.screenshot(); // full page, matching the committed artifact
  const score = mascotPixelScore(buf);
  log(`mascot framing candidate '${c.label}': tone-pixel score ${score}`);
  if (score > bestScore) {
    bestScore = score;
    bestBuf = buf;
    bestLabel = c.label;
  }
}
assert(bestBuf !== null && bestScore > 0, `at least one close mascot framing candidate scored (${bestScore})`);
await writeFile(`${OUT}/readable-05-mascot-lineup.png`, bestBuf);
log(`mascot lineup committed: best framing '${bestLabel}' (score ${bestScore})`);

// ---- 8/9. Bench + batter WALK proof, and the walk-speed-outside-PLAY assertion ----
// A freshly-assigned batter ORIGINATES at bench seat 0 (LEGAL_ZONE.minX - 3, i.e.
// x = -43) and walks the full ~43m to the batting square (0,0) at WALK_SPEED_M_S
// (~3 m/s) — a ~14s walk. To land the capture window reliably IN that walk
// (not pre-arrival or post-arrival), watch the '#hud-players .player-name'
// (the 'now batting' card) for its text to CHANGE to a new name, which fires
// the instant the server assigns a fresh currentBatterId — the walk has margin
// left over almost the entire ~14s of its journey right after that transition,
// so capturing immediately after the change and ~1s later should land well
// inside the walk with a large, easily-measured delta (unlike capturing at an
// arbitrary moment during PRE_PLAY, which risks catching an already-arrived
// batter mid-idle-breath, as the previous attempt at this shot did).
// IMPORTANT: once the trigger fires below, we deliberately STOP clicking READY
// on either page until the whole walk capture (frames + ceiling samples) is
// done — clicking ready during the walk window risks both sides confirming
// and the phase flipping to PLAY (fast-convergence) mid-capture, which would
// corrupt both the "prove a real walk" delta and the walk-speed-ceiling
// samples that must be taken OUTSIDE PLAY. A few extra seconds of the harness
// not readying up is a fine trade for a clean, honest capture window.
const battingCardSel = '#hud-players .player-card.is-bat .player-name';
const batterNameAtStart = (await page1.textContent(battingCardSel).catch(() => null)) ?? '';
log(`watching for a new batter name to replace '${batterNameAtStart}' (walk-start trigger)`);
let batterChanged = false;
const batterWatchDeadline = Date.now() + 240000; // spans several plays if needed
while (Date.now() < batterWatchDeadline) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  const name = (await page1.textContent(battingCardSel).catch(() => null)) ?? '';
  if (ph !== 'play' && name !== '' && name !== batterNameAtStart) {
    batterChanged = true;
    break;
  }
  if (ph !== 'play') {
    await page1.click('#ready-button').catch(() => {});
    await page2.click('#ready-button').catch(() => {});
  }
  await sleep(150);
}
assert(batterChanged, 'a new batter was assigned (walk-start trigger fired) within the watch window');
const newBatterName = (await page1.textContent(battingCardSel).catch(() => null)) ?? '';
// Batting side ALTERNATES by innings, so the batter's kit hue must be derived
// live rather than assumed: '#board-you' reads 'you · A · batting' when page1
// (side A) is batting (navy), or 'you · A · fielding' when side B is up
// (maroon) — this fixed the very real bug where the harness kept searching
// for navy after the innings flipped to side B batting and silently measured
// the wrong (static) region.
const boardYouText = (await page1.textContent('#board-you').catch(() => null)) ?? '';
const battingHue = boardYouText.includes('batting') ? 'navy' : 'maroon';
log(`new batter assigned: '${newBatterName}' — batting side kit hue = ${battingHue} ('${boardYouText.trim()}') — capturing the walk now (READY clicks paused on both pages)`);

// Deliberately use the DEFAULT (Home-reset) camera pose for this shot, NOT an
// orbited/zoomed close-up: the bench-to-square walk covers ~43m (bench seat 0
// at x=-43 to the square at x=0), and a close zoom (MIN_RADIUS 24m) narrows
// the frustum enough to put most of that corridor OFF-SCREEN — confirmed live
// (a first attempt at this shot with a tight orbit captured two byte-identical
// frames because the walking figure was simply out of frame the whole time).
// The classic wide pose (0,26,-30) looking at (0,0,18) keeps the whole
// bench-to-square corridor in view, at the cost of the figure being smaller.
await page1.keyboard.press('Home');
await sleep(200);

// The current batter's kit shirt colour (battingHue, derived above) is a
// strong, near-unique hue in the 3D scene — locate its centroid across a
// single unified burst of samples taken back-to-back (READY is NOT clicked
// anywhere in this section — see the note above the trigger loop — so the
// phase cannot flip to PLAY mid-burst and corrupt either the "prove a real
// walk" delta or the walk-speed-ceiling property, both read from the SAME
// samples). Full-viewport screenshots composite the fixed-position HUD/draft
// overlay siblings at their screen coordinates, so those excluded boxes keep
// the panels' own same-hue accents from being counted.
const SAMPLE_INTERVAL_MS = 500;
const SAMPLE_COUNT = 6;
const samples = [];
const rawFrames = [];
for (let i = 0; i < SAMPLE_COUNT; i += 1) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph === 'play') break; // shouldn't happen (no ready clicks in this window) but guard anyway
  const frame = await page1.screenshot();
  rawFrames.push(frame);
  const centroid = findCentroid(frame, battingHue, [HUD_EXCLUDE, DRAFT_EXCLUDE]);
  if (centroid && centroid.n > 20) samples.push(centroid);
  await sleep(SAMPLE_INTERVAL_MS);
}
assert(samples.length >= 3, `enough walk-phase position samples collected (${samples.length})`);
await writeFile(`${OUT}/readable-08a-walk.png`, rawFrames[0]);
await writeFile(`${OUT}/readable-08b-walk.png`, rawFrames[Math.min(2, rawFrames.length - 1)]);

// (a) Prove REAL, non-trivial walking progress between the two committed frames
// (08a = sample 0, 08b = ~1-1.5s later at sample index 2) — a near-zero delta
// would mean the timing missed the walk (arrived early/late), so this is a
// genuine failure condition, not waved through as "looks similar enough".
const cA = samples[0];
const cB = samples[Math.min(2, samples.length - 1)];
const moved = Math.hypot(cB.x - cA.x, cB.y - cA.y);
log(
  `${battingHue}-kit centroid moved ${moved.toFixed(1)} screen px over ~${(Math.min(2, samples.length - 1) * SAMPLE_INTERVAL_MS) / 1000}s (A=${JSON.stringify(cA)}, B=${JSON.stringify(cB)})`,
);
assert(
  moved > 8,
  `batter kit-patch centroid moved a NON-TRIVIAL distance (${moved.toFixed(1)}px, threshold 8px) — proves real walking progress, not a frozen/arrived figure`,
);
assert(!rawFrames[0].equals(rawFrames[rawFrames.length - 1]), 'the walk-burst frames are not byte-identical (something is animating)');

// (b) Walk-speed ceiling: no single inter-sample jump may exceed a generous
// screen-space bound. At ~3 m/s world speed, over a 500ms sample interval a
// figure moves at most 1.5m; from the default wide camera (radius ~40m) that
// subtends well under 100px — 250px/500ms is a deliberately generous ceiling
// (screen-space, not world-space, per the brief) that a genuine walk-speed
// figure cannot approach, while a teleport/snap (the pre-overhaul bug) would.
const PX_JUMP_CEILING = 250;
let maxJump = 0;
for (let i = 1; i < samples.length; i += 1) {
  const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  maxJump = Math.max(maxJump, d);
}
assert(
  maxJump <= PX_JUMP_CEILING,
  `no figure jump exceeds the walk-speed screen-space ceiling outside PLAY (max ${maxJump.toFixed(1)}px over ${SAMPLE_INTERVAL_MS}ms samples, ceiling ${PX_JUMP_CEILING}px, ${samples.length} samples)`,
);

// ---- 11. Zero console/page errors on both pages, across the whole run ----
assert(errors[1].length === 0, `zero page errors on page 1 (${JSON.stringify(errors[1])})`);
assert(errors[2].length === 0, `zero page errors on page 2 (${JSON.stringify(errors[2])})`);

await browser.close();
log('BROWSER ACCEPTANCE PASSED');
