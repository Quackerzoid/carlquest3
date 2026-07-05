/**
 * Auto-play redesign browser acceptance: two real Chromium pages against live
 * dev servers, watching a play resolve itself through the restyled esports UI.
 *
 *  1. Restyled lobby (create → 4-letter code → join) and draft-sheet
 *     screenshots; full table-order draft clicked through the real card UI.
 *  2. INITIAL_POSITIONING (page 2 = side B, fielding):
 *     - ORBIT: synthetic pointer drag on the canvas changes the rendered view
 *       (screenshot diff, before/after committed); Home resets it (screenshot).
 *     - REPOSITION FROM THE ORBITED CAMERA: a fielder is selected via its panel
 *       row, then the canvas CENTRE is clicked — the orbit keeps its target
 *       (0, 0, 12), a legal ground point, at screen centre. Accepted-move
 *       evidence: the [selected] badge re-renders off the reposition patch
 *       (schema-driven), zero rejection feed lines, AND the selection ring
 *       (0xf4e9c8, pixel-detectable by design) appears at the click point —
 *       sampled 0 cream pixels before, >0 after. A short convergence burst of
 *       clicks (m8 technique) walks the per-patch lerp onto the spot.
 *  3. READY both (Enter) → hands off, WATCH the auto-play on page 1:
 *     - batter standing at the batting square WITH the bat, pre-contact
 *       (screenshot inside the pitch-beat delay);
 *     - roll banner captured. Software-WebGL screenshot latency here is
 *       ~1.3 s — as long as the banner's whole 1.4 s flash — so the shot is of
 *       an animation-FROZEN CLONE of the first real banner node (same DOM
 *       content, pinned below the live stack the instant the real banner is
 *       broadcast); the LIVE stack is untouched and the ≤2-stacked assert
 *       runs against the real nodes only;
 *     - runner mid-circuit (screenshot requested the instant the connect
 *       banner lands; the ~1.3 s capture latency itself provides the delay) —
 *       the run reads counter-clockwise (post 1 renders screen-RIGHT, x = −11);
 *     - a playOutcome resolution lands on the feed with ZERO client play
 *       messages (the client no longer has a send path for any).
 *  4. A SECOND play watched from page 2 with the camera orbited and zoomed onto
 *     the squares: a burst of frames (a…h, one per ~1 s capture) covers the
 *     pitcher's wind-up whip and any re-pitch — the 2026-07-05 run's frame (a)
 *     caught Kian mid-whip with the ball just released AND the navy batter in
 *     profile with the bat visible over the shoulder (frames a–b committed,
 *     the rest pruned); then a timing-safe PRE_PLAY batter close-up.
 *
 * Screenshots (written to argv[2], default alongside; committed set pruned to
 * the evidence frames):
 *   autoplay-01a-lobby.png, autoplay-01b-draft.png, autoplay-02-roll-banner.png,
 *   autoplay-03-run-ccw.png, autoplay-04-batter-bat.png,
 *   autoplay-04b-batter-closeup.png, autoplay-05-framing.png (restyled
 *   positioning panel), autoplay-05-windup-{a..h}.png (burst; a–b committed),
 *   autoplay-06a-orbit-before.png, autoplay-06b-orbit-after.png,
 *   autoplay-06c-home-reset.png, autoplay-07-reposition.png
 * Every expectation throws on failure.
 *
 * Playwright/pngjs are NOT repo dependencies (kept out of the workspaces on
 * purpose). To run: `npm i playwright pngjs` in a scratch dir (plus
 * `npx playwright install chromium` once), copy this file there, then
 * `node autoplay-browser-acceptance.mjs <output-dir> [app-url]`.
 * Port note (2026-07-05 run): 5173/2567 were held by a stale unkillable pair
 * from another session, so the recorded run served Vite on 5199 and the
 * Colyseus app on 2568, with a page init script rewriting :2567 → :2568 on
 * WebSocket/fetch/XHR (NetModule's hardcoded 2567 untouched). Against a normal
 * `npm run dev`, pass http://localhost:5173 and the shim is a no-op.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const OUT = process.argv[2] ?? '.';
const URL_APP = process.argv[3] ?? 'http://localhost:5199';
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const assert = (cond, what) => {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`OK: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECT_PICKS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy'];
const RESOLUTION_RE = /caught by |run out at post |safe at post |rounder!/;
// RenderModule RING_SELECTED (0xf4e9c8) — kept pixel-detectable by design (M10 technique).
const RING = { r: 0xf4, g: 0xe9, b: 0xc8 };
const RING_TOL = 45;

/** Count pixels within RING_TOL of the selection-ring cream in a centre box of a PNG buffer. */
function ringPixels(buf, boxHalf = 70) {
  const png = PNG.sync.read(buf);
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  let count = 0;
  for (let y = cy - boxHalf; y <= cy + boxHalf; y += 1) {
    for (let x = cx - boxHalf; x <= cx + boxHalf; x += 1) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const i = (png.width * y + x) << 2;
      if (
        Math.abs(png.data[i] - RING.r) <= RING_TOL &&
        Math.abs(png.data[i + 1] - RING.g) <= RING_TOL &&
        Math.abs(png.data[i + 2] - RING.b) <= RING_TOL
      )
        count += 1;
    }
  }
  return count;
}

const browser = await chromium.launch();
const errors = { 1: [], 2: [] };
const mkPage = async (n) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    // Route the game connection to this worktree's server when it runs on 2568
    // (no-op against a normal npm run dev on 2567).
    const rewrite = (u) => (typeof u === 'string' && window.location.port === '5199' ? u.replace(':2567', ':2568') : u);
    const NativeWS = window.WebSocket;
    window.WebSocket = class extends NativeWS {
      constructor(url, protocols) {
        super(rewrite(url), protocols);
      }
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => nativeFetch(typeof input === 'string' ? rewrite(input) : input, init);
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      return nativeOpen.call(this, method, rewrite(url), ...rest);
    };
    window.__rolls = [];
    new MutationObserver((muts) => {
      for (const m of muts)
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.classList?.contains('roll-banner')) window.__rolls.push(node.textContent);
        }
    }).observe(document, { childList: true, subtree: true });
  });
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

// ---- 1. Restyled lobby + code flow ----
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
assert(/^[A-Z]{4}$/.test(code), `4-letter room code displayed (got '${code}')`);
await page1.screenshot({ path: `${OUT}/autoplay-01a-lobby.png` });
await page2.fill('#join-code', code);
await page2.click('#lobby-join');

for (const [i, page] of [page1, page2].entries()) {
  await page.waitForSelector('#draft:not([hidden])', { timeout: 20000 });
  await page.evaluate(() => document.activeElement?.blur());
  log(`page ${i + 1} reached DRAFT`);
}
await page1.screenshot({ path: `${OUT}/autoplay-01b-draft.png` });

// ---- 2. Full draft click-through (the m7/m8 helper, selectors unchanged) ----
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

// ---- 3. Orbit + reposition from the orbited camera (page 2, fielding side) ----
const legend2 = (await page2.textContent('#hud-legend')) ?? '';
assert(legend2.includes('drag to orbit'), `fielding legend carries the orbit hint ('${legend2.trim()}')`);
assert(legend2.includes('click fielder'), 'fielding legend carries the reposition hint');
assert(!/\[P\]|\[Space\]|\[R\]|\[T\]|\[A\/S\/D\]/.test(legend2), 'no retired play keys in the legend');

const box = await page2.locator('#app').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page2.screenshot({ path: `${OUT}/autoplay-06a-orbit-before.png` });
const before = await page2.locator('#app').screenshot();
await page2.mouse.move(cx, cy);
await page2.mouse.down();
for (let i = 1; i <= 10; i += 1) await page2.mouse.move(cx + i * 18, cy - i * 6);
await page2.mouse.up();
await sleep(300);
const after = await page2.locator('#app').screenshot();
assert(!before.equals(after), 'orbit drag changed the rendered view');
await page2.screenshot({ path: `${OUT}/autoplay-06b-orbit-after.png` });

// No selection yet: zero ring-cream pixels at the canvas centre.
const ringsBefore = ringPixels(await page2.locator('#app').screenshot());
assert(ringsBefore === 0, `no selection-ring pixels at the click target before the move (${ringsBefore})`);

// Select a non-bowler fielder via its panel row, then click the canvas centre —
// with the orbited camera the centre still maps to the orbit target (0, 0, 12),
// a legal ground spot. Convergence burst (m8 technique): each accepted click is
// a real schema move + patch; the per-patch lerp needs a few to land visually.
const fieldRow = page2.locator('#draft .draft-row[data-role="field"]').first();
const movedId = await fieldRow.getAttribute('data-id');
await fieldRow.click();
log(`clicked panel row for fielder '${movedId}'`);
const feedCount = await page2.locator('#hud-feed .feed-entry').count();
await sleep(200); // clear of the camera drag-suppression hold (150 ms)
for (let i = 0; i < 7; i += 1) {
  await page2.mouse.click(cx, cy);
  await sleep(180);
}
// Accepted-move evidence 1: the [selected] badge re-renders off the reposition
// patch (the panel only re-renders when a schema patch arrives).
await page2.waitForFunction(
  (id) =>
    document.querySelector(`#draft .draft-row[data-id="${id}"] .draft-row-badge`)?.textContent?.includes('[selected]') ??
    false,
  movedId,
  { timeout: 8000 },
);
log(`'${movedId}' shows [selected] off the reposition patch — schema move accepted`);
// Accepted-move evidence 2: zero rejection lines on the feed.
await sleep(400);
const newFeed = await page2.locator('#hud-feed .feed-entry').allTextContents();
const rejections = newFeed
  .slice(0, Math.max(0, newFeed.length - feedCount))
  .filter((t) => /illegal|not your role|paused|only allowed/.test(t));
assert(rejections.length === 0, `reposition from the orbited camera not rejected (feed: ${JSON.stringify(newFeed)})`);
// Accepted-move evidence 3: the selection ring is now AT the click target.
const ringsAfter = ringPixels(await page2.locator('#app').screenshot());
assert(ringsAfter > 0, `selection-ring pixels present at the click target after the move (${ringsAfter})`);
await page2.screenshot({ path: `${OUT}/autoplay-07-reposition.png` });

// Home resets the camera.
await page2.keyboard.press('Home');
await sleep(300);
await page2.screenshot({ path: `${OUT}/autoplay-06c-home-reset.png` });

// ---- 4. READY both → hands off, WATCH the auto-play ----
for (;;) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph === 'play') break;
  if (ph === 'initial positioning' || ph === 'pre play') {
    await page1.keyboard.press('Enter');
    await page2.keyboard.press('Enter');
  }
  if (Date.now() - T0 > 180000) throw new Error(`stuck advancing to PLAY (phase '${ph}')`);
  await sleep(200);
}
log('phase PLAY — hands off, watching');
// Arm the banner pin: the instant the FIRST real roll banner is broadcast, an
// animation-frozen clone of its node is placed BELOW the live stack so the
// ~1.3 s software-WebGL screenshot latency cannot outlive it. The live stack
// (and its max-2/1.4 s behaviour) is untouched.
await page1.evaluate(() => {
  const src = document.querySelector('#roll-banners');
  const obs = new MutationObserver((muts) => {
    if (window.__pinned) return;
    for (const m of muts)
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains('roll-banner')) {
          const pin = document.createElement('div');
          pin.id = '__banner-pin';
          Object.assign(pin.style, {
            position: 'fixed',
            top: '110px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: '99',
            pointerEvents: 'none',
          });
          const clone = n.cloneNode(true);
          clone.style.animation = 'none';
          clone.style.opacity = '1';
          pin.append(clone);
          document.body.append(pin);
          window.__pinned = true;
          obs.disconnect();
          return;
        }
      }
  });
  obs.observe(src, { childList: true });
});

// Batter at the square with the bat, pre-contact: shot inside the pitch delay.
await page1.screenshot({ path: `${OUT}/autoplay-04-batter-bat.png` });
const legendPlay = (await page1.textContent('#hud-legend')) ?? '';
assert(legendPlay.includes('play in progress — the dice decide'), `PLAY legend ('${legendPlay.trim()}')`);

// Roll banner: shoot the pinned clone (fully opaque regardless of capture lag).
await page1.waitForFunction(() => window.__pinned === true, undefined, { timeout: 12000 });
await page1.screenshot({ path: `${OUT}/autoplay-02-roll-banner.png` });
await page1.evaluate(() => document.querySelector('#__banner-pin')?.remove());
log('roll banner captured (pinned clone of the first real banner)');

// Runner mid-circuit: request the shot the INSTANT the connect banner lands —
// the ~1.3 s capture latency itself puts the runner several metres up the
// first leg (screen-right, towards post 1 at x = −11).
await page1.waitForFunction(() => window.__rolls.some((t) => /connects!/i.test(t)), undefined, { timeout: 120000 });
await page1.screenshot({ path: `${OUT}/autoplay-03-run-ccw.png` });
log('mid-run frame captured (requested at the connect banner)');

// The play resolves itself: a resolution line lands on the feed, zero client
// play messages (no send path exists in the shipped client).
await page1.waitForFunction(
  (re) => [...document.querySelectorAll('#hud-feed .feed-entry')].some((e) => new RegExp(re).test(e.textContent ?? '')),
  RESOLUTION_RE.source,
  { timeout: 60000 },
);
const rolls1 = await page1.evaluate(() => window.__rolls);
assert(rolls1.length >= 2, `roll banners observed (${rolls1.length}): ${JSON.stringify(rolls1.slice(0, 5))}`);
assert(await page1.locator('#roll-banners .roll-banner').count() <= 2, 'never more than 2 banners stacked');
const resolved = (await page1.locator('#hud-feed .feed-entry').allTextContents()).find((t) => RESOLUTION_RE.test(t));
assert(Boolean(resolved), `play resolved with zero client play messages ('${resolved}')`);

// ---- 5. Second play, watched CLOSE-UP from page 2: batter-with-bat profile +
// pitcher wind-up burst. Orbit low and zoom onto the two squares first.
await page1.waitForFunction(() => document.querySelector('#board-phase')?.textContent !== 'play', undefined, { timeout: 60000 });
const box2 = await page2.locator('#app').boundingBox();
const cx2 = box2.x + box2.width / 2;
const cy2 = box2.y + box2.height / 2;
await page2.mouse.move(cx2, cy2);
await page2.mouse.down();
for (let i = 1; i <= 10; i += 1) await page2.mouse.move(cx2 + i * 14, cy2 + i * 4);
await page2.mouse.up();
for (let i = 0; i < 2; i += 1) {
  await page2.mouse.wheel(0, -240);
  await sleep(60);
}
await sleep(250);
await page2.screenshot({ path: `${OUT}/autoplay-05-framing.png` });
for (;;) {
  const ph = (await page1.textContent('#board-phase'))?.trim() ?? '';
  if (ph === 'play') break;
  if (ph === 'initial positioning' || ph === 'pre play') {
    await page1.keyboard.press('Enter');
    await page2.keyboard.press('Enter');
  }
  if (Date.now() - T0 > 300000) throw new Error(`stuck advancing to the second PLAY (phase '${ph}')`);
  await sleep(200);
}
log('second PLAY — close-up burst from the orbited page 2');
for (const frame of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
  await page2.screenshot({ path: `${OUT}/autoplay-05-windup-${frame}.png` });
}
log('wind-up burst captured (frames a–h, one per ~1 s capture — covers pre-pitch, whip and any re-pitch)');

// Batter close-up, timing-safe: in the NEXT PRE_PLAY the incoming batter stands
// at the batting square holding the bat (a static scene, immune to capture lag).
await page2.waitForFunction(() => document.querySelector('#board-phase')?.textContent !== 'play', undefined, { timeout: 120000 });
await sleep(400);
await page2.screenshot({ path: `${OUT}/autoplay-04b-batter-closeup.png` });
log('PRE_PLAY batter close-up captured from the orbited camera');

assert(errors[1].length === 0, `zero page errors on page 1 (${JSON.stringify(errors[1])})`);
assert(errors[2].length === 0, `zero page errors on page 2 (${JSON.stringify(errors[2])})`);

await browser.close();
log('BROWSER ACCEPTANCE PASSED');
