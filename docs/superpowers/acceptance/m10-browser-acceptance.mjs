/**
 * M10 browser acceptance (spec §9.10): two real Chromium pages in SEPARATE
 * browser contexts against the live dev servers (`npm run dev` — Vite on 5173,
 * Colyseus on 2567), driving a COMPLETE game through the real UI:
 *
 *  1. Restyled lobby: create shows the share-cue + 4-letter code (screenshot
 *     m10-01), join by code.
 *  2. Full table-order draft clicked through the sheet (the m7/m8 helper).
 *  3. Real-keydown play: Enter/Enter to PLAY, fielding page pitches (P, with
 *     A/S/D spin variety), batting page swings (Space). First play asserts the
 *     HUD: board phase/identity on both pages, the key legend lighting EXACTLY
 *     the batting keys (Space/R/T) on the batting page and the fielding keys
 *     (A/S/D + P) on the other, screenshot m10-02 mid-play; every play asserts
 *     the feed's resolution line and that the scoreboard equals the running
 *     total accumulated from the feed's own `+N½` deltas (cross-checked
 *     page 1 vs page 2 — both render the same authoritative state).
 *  4. Drive to GAME_OVER (batting side re-read from the board every play, so
 *     innings switches and any tiebreak pairs are handled by the same loop).
 *     Result overlay asserted (score matches the accumulated total, WINNER is
 *     the higher side, [N] rematch lit; screenshot m10-03), then REMATCH is
 *     CLICKED → both pages assert score zeroed, overlay gone, feed shows
 *     `rematch started` (screenshot m10-04).
 *  5. Reconnect drill (in the fresh rematch game): page 2's Colyseus WebSocket
 *     (only sockets to :2567 — closing Vite's HMR socket would reload the page)
 *     is force-closed via an init-script WebSocket hook — an UNCONSENTED drop.
 *     An 800 ms CDP latency emulation on page 2's HTTP (matchmaking reconnect
 *     is an HTTP round-trip; established WebSockets are NOT throttled by CDP —
 *     the same limitation the probe below documents) widens the pause window so
 *     page 1 visibly pauses. Asserted: page 1 feed `game paused — opponent
 *     disconnected` (+ best-effort catch of the paused legend notice), page 2
 *     feed `connection lost — reconnecting…` then `reconnected` (the shipped
 *     ONE-ATTEMPT auto-reconnect), page 1 feed `game resumed`, and BOTH pages
 *     live afterwards: Enter on both advances BOTH boards to `pre play` (page
 *     2's HUD updating proves the fresh room's wiring).
 *  6. `context.setOffline(true)` probe (informational, LAST — logged, not
 *     asserted): documents whether CDP offline emulation affects the
 *     established game WebSocket in this Chromium at all.
 *  7. Out-runner topple (best-effort): on the first play resolving with an out,
 *     an immediate screenshot is pixel-sampled for the red toppled capsule
 *     (0xc0392b; the ball mesh is hidden at play end, and no other red-dominant
 *     ink exists in the frame) against a pre-game baseline. Logged honestly if
 *     no out occurs on-screen in time.
 *  8. Throughout: zero page errors on either page; console errors (filtered of
 *     browser network noise from the deliberate disconnects, which is logged
 *     separately) must be zero; RunnersView.markOut console.warn occurrences
 *     are counted and reported (Task-3 review asked whether it spams).
 *
 * Screenshots (written to argv[2], or next to this script):
 *   m10-01-lobby.png         — page 1's restyled lobby, waiting state + code
 *   m10-02-play-hud.png      — page 1 mid-play: board, feed, lit batting legend
 *   m10-03-result-overlay.png— GAME_OVER result card: score, WINNER, buttons
 *   m10-04-rematch-fresh.png — after clicking REMATCH: zeroed board, no overlay
 * Every expectation throws on failure (exit non-zero).
 *
 * Playwright/pngjs are NOT repo dependencies (kept out of the workspaces on
 * purpose). To run: `npm i playwright pngjs` in a scratch dir (plus
 * `npx playwright install chromium` once), copy this file there, then
 * `node m10-browser-acceptance.mjs <output-dir>`.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const OUT = process.argv[2] ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const URL_APP = 'http://localhost:5173';
const T0 = Date.now();
const WATCHDOG_MS = 9.5 * 60 * 1000;
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const assert = (cond, what) => {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`OK: ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checkWatchdog = () => {
  if (Date.now() - T0 > WATCHDOG_MS) throw new Error('WATCHDOG: acceptance exceeded 9.5 minutes');
};

const EXPECT_PICKS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy'];
const RESOLUTION_RE = /caught by |run out at post |safe at post |rounder!/;

/** Count red-dominant pixels (toppled runner 0xc0392b under Lambert light). */
function countReddish(png) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (r > 90 && r > 1.4 * g && r > 1.4 * b) n += 1;
  }
  return n;
}

const browser = await chromium.launch();
const errors = { 1: [], 2: [] };
const netNoise = { 1: [], 2: [] };
const markOutWarns = { 1: 0, 2: 0 };
const mkPage = async (n) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  // Capture game-socket instances so the reconnect drill can force an
  // unconsented drop (Vite's HMR socket is deliberately NOT touched).
  await page.addInitScript(() => {
    window.__ws = [];
    const NativeWS = window.WebSocket;
    window.WebSocket = class extends NativeWS {
      constructor(...args) {
        super(...args);
        window.__ws.push(this);
      }
    };
  });
  page.on('pageerror', (e) => errors[n].push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'warning' && text.includes('RunnersView.markOut')) markOutWarns[n] += 1;
    if (msg.type() === 'error') {
      if (/WebSocket|net::|Failed to load resource/.test(text)) netNoise[n].push(text);
      else errors[n].push(`console.error: ${text}`);
    }
  });
  return page;
};
const page1 = await mkPage(1); // creator → side A (bats innings 1)
const page2 = await mkPage(2); // joiner → side B (fields innings 1)
const pages = [page1, page2];

await page1.goto(URL_APP);
await page2.goto(URL_APP);

// ===================== 1. Restyled lobby: create + join by code =====================
assert((await page1.textContent('#lobby-card .title'))?.trim() === 'Carl Quest Sports', 'lobby title plate renders');
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const cue = (await page1.textContent('#lobby-waiting .cue'))?.trim() ?? '';
assert(cue === 'share this code with your opponent', `share-this-code cue renders (got '${cue}')`);
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
assert(/^[A-Z]{4}$/.test(code), `4-letter room code displayed (got '${code}')`);
await page1.screenshot({ path: `${OUT}/m10-01-lobby.png` });
await page2.fill('#join-code', code);
await page2.click('#lobby-join');

for (const [i, page] of pages.entries()) {
  await page.waitForSelector('#draft:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#hud')?.hidden === false, { timeout: 5000 });
  // Blur whatever lobby control still holds focus so later Enter/Space keydowns
  // land on <body> (a focused button would re-fire its click on Enter).
  await page.evaluate(() => document.activeElement?.blur());
  log(`page ${i + 1} reached DRAFT with the pick sheet + HUD visible`);
}

// ===================== 2. Full draft click-through (m7/m8 helper) =====================
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
      const phase = document.querySelector('#board-phase')?.textContent ?? '';
      return (badge !== null && badge.textContent !== '') || phase !== 'draft';
    },
    id,
    { timeout: 10000 },
  );
}
assert(JSON.stringify(clicked) === JSON.stringify(EXPECT_PICKS), `table-order draft clicked through the UI (${clicked.join(',')})`);

for (const [i, page] of pages.entries()) {
  await page.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent === 'initial positioning',
    { timeout: 20000 },
  );
  log(`page ${i + 1} board shows phase 'initial positioning'`);
}

// Pre-game red-pixel baseline for the out-runner topple check (no ball, no runners).
const baselineRed = countReddish(PNG.sync.read(await page1.screenshot()));
log(`red-pixel baseline (pre-game): ${baselineRed}`);

// ===================== Helpers for the play loop =====================
const phaseOf = async (page) => (await page.textContent('#board-phase'))?.trim() ?? '';
const scoreOf = async (page) => {
  const text = (await page.textContent('#board-score'))?.trim() ?? '';
  const m = /^A (\d+)½ – B (\d+)½$/.exec(text);
  if (!m) throw new Error(`unparseable board score '${text}'`);
  return { a: Number(m[1]), b: Number(m[2]), text };
};

/** Enter on both pages until PLAY (or GAME_OVER) — covers confirm AND ready gates. */
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

/** Batting/fielding pages for THIS play, read from the authoritative identity line. */
async function currentRoles() {
  const you1 = (await page1.textContent('#board-you')) ?? '';
  return you1.includes('batting') ? { bat: page1, field: page2, battingSide: 'A' } : { bat: page2, field: page1, battingSide: 'B' };
}

let toppleChecked = false;
let toppleResult = 'no out occurred on-screen — topple unverified (best-effort per the brief)';

/** Drive one play with real keydowns; returns the feed's resolution line. */
async function drivePlay(n) {
  // BOTH clients must have received the PLAY patch before any key lands: the
  // key handlers gate on each page's OWN synced phase (myRole() is null until
  // the patch arrives), so a key pressed against a stale phase is swallowed
  // client-side and the play would sit pitchless forever.
  await Promise.all(pages.map((p) => p.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent === 'play',
    { timeout: 10000 },
  )));
  const roles = await currentRoles();
  // Mark every existing feed entry so the resolution wait keys on a NEW line.
  await page1.evaluate(() => {
    for (const e of document.querySelectorAll('#hud-feed .feed-entry')) e.dataset.seen = '1';
  });
  const spinKeys = ['s', 'a', 'd'];
  const pressKeys = async (attempt) => {
    await roles.field.keyboard.press(spinKeys[(n + attempt) % 3]);
    await roles.field.keyboard.press('p');
    // Swing delay band 260–360 ms: the pitch reaches the batting plane ~0.45 s
    // after release and the timing window is tight (~±50 ms) — delays much past
    // 400 ms MISS, and a missed swing is (by design, M3) not a resolution: the
    // ball quietly respawns and the play stays in PLAY awaiting a re-pitch.
    // Hence the attempt loop below rather than a single fire-and-wait.
    await sleep(260 + ((n + attempt) % 3) * 50);
    await roles.bat.keyboard.press(' ');
  };
  const waitResolution = (ms) => page1.waitForFunction(
    (re) => [...document.querySelectorAll('#hud-feed .feed-entry')]
      .some((e) => !e.dataset.seen && new RegExp(re).test(e.textContent ?? '')),
    RESOLUTION_RE.source,
    { timeout: ms },
  ).then(() => true).catch(() => false);
  let resolved = false;
  for (let attempt = 0; attempt < 4 && !resolved; attempt += 1) {
    await pressKeys(attempt);
    if (n === 0 && attempt === 0) await page1.screenshot({ path: `${OUT}/m10-02-play-hud.png` });
    // 8.5 s covers a full missed-swing cycle (6 s play timeout + rest + patch).
    resolved = await waitResolution(8500);
    if (!resolved) log(`play ${n + 1}: no resolution (swing likely missed → silent re-pitch state) — attempt ${attempt + 2}`);
  }
  if (!resolved) throw new Error(`play ${n + 1}: no resolution after 4 pitch/swing attempts`);
  const line = await page1.evaluate((re) => {
    const hit = [...document.querySelectorAll('#hud-feed .feed-entry')]
      .find((e) => !e.dataset.seen && new RegExp(re).test(e.textContent ?? ''));
    return hit?.textContent ?? '';
  }, RESOLUTION_RE.source);
  // Best-effort out-runner topple check: keep trying on each out-carrying play
  // until a capture lands inside markOut's 1.5 s retention window.
  if (!toppleChecked && /caught by |run out at post |out:/.test(line)) {
    const red = countReddish(PNG.sync.read(await page1.screenshot()));
    if (red - baselineRed >= 100) {
      toppleChecked = true;
      toppleResult = `VERIFIED: red toppled capsule visible after '${line}' (${red} red px vs baseline ${baselineRed})`;
    } else {
      toppleResult = `NOT CAPTURED on any out-carrying play (last attempt: ${red} red px vs baseline ${baselineRed} after '${line}'; markOut warns so far p1=${markOutWarns[1]} p2=${markOutWarns[2]})`;
    }
    log(`out-runner topple attempt: ${toppleResult}`);
  }
  // Wait out the resolve transition so the next iteration reads a settled phase.
  await page1.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent !== 'play',
    { timeout: 10000 },
  );
  return { line, battingSide: roles.battingSide };
}

// ===================== 3–4. Play to GAME_OVER, scoreboard vs feed every play =====================
const expected = { a: 0, b: 0 };
let plays = 0;
let firstPlayAsserted = false;
for (;;) {
  checkWatchdog();
  const ph = await advanceToPlay();
  if (ph === 'game over') break;
  if (!firstPlayAsserted) {
    firstPlayAsserted = true;
    // First PLAY: identities + the legend lighting EXACTLY each page's role keys.
    const roles = await currentRoles();
    for (const [who, page, want] of [
      ['batting', roles.bat, ['[Space] swing', '[R] run', '[T] stop']],
      ['fielding', roles.field, ['[A/S/D] spin', '[P] pitch']],
    ]) {
      const lit = (await page.locator('#hud-legend .legend-item.is-lit').allTextContents()).map((t) => t.trim());
      assert(
        JSON.stringify(lit) === JSON.stringify(want),
        `${who} page legend lights exactly ${want.join(' + ')} (got: ${lit.join(' | ')})`,
      );
    }
    assert((await phaseOf(page2)) === 'play', 'both boards show phase play');
  }
  const { line, battingSide } = await drivePlay(plays);
  plays += 1;
  const delta = Number(/\+(\d+)½/.exec(line)?.[1] ?? 0);
  if (battingSide === 'A') expected.a += delta;
  else expected.b += delta;
  const want = `A ${expected.a}½ – B ${expected.b}½`;
  await page1.waitForFunction(
    (w) => document.querySelector('#board-score')?.textContent?.trim() === w,
    want,
    { timeout: 5000 },
  );
  const s2 = await scoreOf(page2);
  if (s2.text !== want) throw new Error(`page 2 board score '${s2.text}' != expected '${want}'`);
  log(`play ${plays} (${battingSide} batting): ${line} — board ${want} on both pages`);
  if (plays > 80) throw new Error('80 plays without GAME_OVER — aborting');
}
assert(plays >= 1, `at least one play resolved via real keydowns (${plays} plays driven)`);
log(`GAME_OVER after ${plays} plays — accumulated A ${expected.a}½ – B ${expected.b}½`);

// ===================== 4b. Result overlay + REMATCH click =====================
for (const [i, page] of pages.entries()) {
  await page.waitForFunction(() => document.querySelector('#hud-result')?.hidden === false, { timeout: 5000 });
  log(`page ${i + 1} result overlay visible`);
}
const resultScore = (await page1.textContent('#result-score'))?.trim();
assert(resultScore === `A ${expected.a}½ – B ${expected.b}½`, `result score matches the accumulated total (got '${resultScore}')`);
const winner = (await page1.textContent('#result-winner'))?.trim() ?? '';
const expectWinner = expected.a > expected.b ? 'A' : 'B';
assert(winner === `WINNER: ${expectWinner}`, `result names the higher side (got '${winner}', scores A ${expected.a} B ${expected.b})`);
const resultLine = (await page1.textContent('#result-line'))?.trim() ?? '';
assert(/^after \d+ innings/.test(resultLine), `result innings line renders (got '${resultLine}')`);
const litOver = (await page1.locator('#hud-legend .legend-item.is-lit').allTextContents()).map((t) => t.trim());
assert(JSON.stringify(litOver) === JSON.stringify(['[N] rematch']), `GAME_OVER legend lights exactly [N] rematch (got: ${litOver.join(' | ')})`);
await page1.screenshot({ path: `${OUT}/m10-03-result-overlay.png` });

await page1.click('#result-rematch');
for (const [i, page] of pages.entries()) {
  await page.waitForFunction(
    () => document.querySelector('#board-score')?.textContent?.trim() === 'A 0½ – B 0½'
      && document.querySelector('#hud-result')?.hidden === true,
    { timeout: 10000 },
  );
  const feed = await page.locator('#hud-feed .feed-entry').allTextContents();
  assert(feed.includes('rematch started'), `page ${i + 1} feed shows 'rematch started' after REMATCH click (got: ${feed.join(' | ')})`);
  log(`page ${i + 1} rematch: score zeroed, overlay gone`);
}
await page1.waitForFunction(
  () => document.querySelector('#board-phase')?.textContent === 'initial positioning',
  { timeout: 10000 },
);
log('rematch game rests in initial positioning');
await page1.screenshot({ path: `${OUT}/m10-04-rematch-fresh.png` });

// ===================== 5. Reconnect drill (unconsented drop + one-attempt auto-reconnect) =====================
// 800 ms latency on page 2's HTTP requests: the matchmaking reconnect round-trip is
// HTTP, so this widens the pause window enough for page 1's patches to show it.
// (Established WebSockets are NOT throttled by CDP network emulation.)
const cdp = await page2.context().newCDPSession(page2);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 800, downloadThroughput: -1, uploadThroughput: -1 });

// Best-effort concurrent catch of page 1's transient paused legend notice.
const pausedLegendPromise = page1
  .waitForFunction(
    () => document.querySelector('#hud-legend .legend-notice')?.textContent === 'paused — waiting for reconnect',
    { timeout: 15000 },
  )
  .then(() => true)
  .catch(() => false);

const closed = await page2.evaluate(() => {
  let n = 0;
  for (const ws of window.__ws) {
    if (ws.url.includes(':2567') && ws.readyState <= 1) {
      ws.close();
      n += 1;
    }
  }
  return n;
});
assert(closed >= 1, `page 2 game socket force-closed (unconsented drop; ${closed} socket(s))`);

await page2.waitForFunction(
  () => [...document.querySelectorAll('#hud-feed .feed-entry')].some((e) => e.textContent?.includes('connection lost — reconnecting…')),
  { timeout: 8000 },
);
log("page 2 feed: 'connection lost — reconnecting…'");
await page1.waitForFunction(
  () => [...document.querySelectorAll('#hud-feed .feed-entry')].some((e) => e.textContent?.includes('game paused — opponent disconnected')),
  { timeout: 8000 },
);
log("page 1 feed: 'game paused — opponent disconnected' (opponent's HUD shows the pause)");
await page2.waitForFunction(
  () => [...document.querySelectorAll('#hud-feed .feed-entry')].some((e) => e.textContent === 'reconnected'),
  { timeout: 15000 },
);
log("page 2 feed: 'reconnected' (the one-attempt auto-reconnect succeeded)");
await page1.waitForFunction(
  () => [...document.querySelectorAll('#hud-feed .feed-entry')].some((e) => e.textContent === 'game resumed'),
  { timeout: 10000 },
);
log("page 1 feed: 'game resumed'");
log(`page 1 paused legend notice caught mid-window: ${(await pausedLegendPromise) ? 'YES' : 'no (window too short for the poll — the durable feed entries above prove the pause round-trip)'}`);
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

// BOTH live: page 1 unpaused (no notice), and Enter on both advances BOTH boards
// (page 2's board moving proves the fresh room's state stream + input re-wiring).
const notice1 = await page1.locator('#hud-legend .legend-notice').count();
assert(notice1 === 0, 'page 1 legend paused notice cleared (unpaused)');
await page1.keyboard.press('Enter');
await page2.keyboard.press('Enter');
for (const [i, page] of pages.entries()) {
  await page.waitForFunction(
    () => document.querySelector('#board-phase')?.textContent === 'pre play',
    { timeout: 10000 },
  );
  log(`page ${i + 1} board advanced to 'pre play' after reconnect — HUD live`);
}

// ===================== 6. setOffline probe (informational — logged, not asserted) =====================
const pausedBefore = await page1.evaluate(
  () => [...document.querySelectorAll('#hud-feed .feed-entry')].filter((e) => e.textContent?.includes('game paused')).length,
);
await page2.context().setOffline(true);
await sleep(4000);
const pausedAfter = await page1.evaluate(
  () => [...document.querySelectorAll('#hud-feed .feed-entry')].filter((e) => e.textContent?.includes('game paused')).length,
);
await page2.context().setOffline(false);
await sleep(1500);
if (pausedAfter > pausedBefore) {
  const lobbyVisible = await page2.evaluate(() => document.querySelector('#lobby')?.hidden === false);
  log(`setOffline probe: offline emulation DID drop the game socket; page 2 ${lobbyVisible ? "fell back to the lobby ('connection lost') — the one-attempt reconnect fired while offline and failed, per the documented design" : 'recovered'}`);
} else {
  log('setOffline probe: context.setOffline(true) did NOT affect the established game WebSocket in this Chromium (known CDP network-emulation limitation) — hence the drill above forces the drop via a raw socket close instead');
}

// ===================== 7–8. Error hygiene + markOut warn census =====================
log(`out-runner topple (best-effort): ${toppleResult}`);
for (const n of [1, 2]) {
  log(`page ${n} markOut console.warn count: ${markOutWarns[n]} ${markOutWarns[n] <= plays ? '(no spam — at most one per out-carrying play)' : '(POSSIBLE SPAM — exceeds play count)'}`);
  if (netNoise[n].length > 0) log(`page ${n} browser network noise from deliberate disconnects (informational): ${netNoise[n].slice(0, 3).join(' ;; ')}${netNoise[n].length > 3 ? ` (+${netNoise[n].length - 3} more)` : ''}`);
  assert(errors[n].length === 0, `page ${n} logged no page/console errors (${errors[n].join(' ;; ')})`);
}

log(`M10 BROWSER ACCEPTANCE PASSED — ${plays} plays, winner ${expectWinner}, reconnect drill clean`);
await browser.close();
