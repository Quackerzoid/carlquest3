/**
 * M6 browser acceptance (spec §9.6): two real Chromium pages against the live
 * dev servers (`npm run dev` — Vite on 5173, Colyseus on 2567).
 *
 * Page 1 clicks Create and the lobby overlay must DISPLAY the 4-letter room
 * code (read from the DOM — the M6 defect fixed at b5608ca was this code being
 * hidden instantly); page 2 types that code and joins; BOTH pages must reach
 * INITIAL_POSITIONING. Screenshots m6-01/02/03 are written next to this script.
 *
 * Playwright is NOT a repo dependency (kept out of the workspaces on purpose).
 * To run: `npm i playwright` in a scratch dir (plus `npx playwright install
 * chromium` once), copy this file there, then `node m6-browser-acceptance.mjs`
 * — or point NODE_PATH at the scratch node_modules and run it in place.
 */
import { chromium } from 'playwright';

// file:// URL pathnames on Windows come back as e.g. "/D:/..." (leading slash
// before the drive letter) — strip it so path.join()/fs calls get a real
// Windows path instead of a bogus rooted-at-"/" one. No-op on POSIX (no match).
const OUT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const URL_APP = 'http://localhost:5173';
const log = (m) => console.log(m);

const browser = await chromium.launch();
const ctx1 = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page1 = await ctx1.newPage();
const page2 = await ctx2.newPage();

await page1.goto(URL_APP);
await page2.goto(URL_APP);

// Page 1: create → waiting lobby displays the room code.
await page1.click('#lobby-create');
await page1.waitForSelector('#lobby-waiting', { state: 'visible' });
const code = (await page1.textContent('#lobby-code'))?.trim() ?? '';
log(`page 1 created match; displayed code = ${code}`);
if (!/^[A-Z]{4}$/.test(code)) throw new Error(`bad code read from DOM: '${code}'`);
await page1.screenshot({ path: `${OUT}/m6-01-create-code.png` });

// Page 2: type the code read from page 1's DOM, screenshot the join lobby, join.
await page2.fill('#join-code', code);
await page2.screenshot({ path: `${OUT}/m6-02-join-lobby.png` });
await page2.click('#lobby-join');

// Both pages must reach INITIAL_POSITIONING (game starts once both are seated).
const inPositioning = async (page) =>
  ((await page.textContent('#status')) ?? '').startsWith('INITIAL_POSITIONING');
for (let i = 0; i < 200; i += 1) {
  if ((await inPositioning(page1)) && (await inPositioning(page2))) break;
  await new Promise((r) => setTimeout(r, 100));
}
const s1 = await page1.textContent('#status');
const s2 = await page2.textContent('#status');
log(`page 1 status: ${s1?.split('\n')[0]}`);
log(`page 2 status: ${s2?.split('\n')[0]}`);
if (!s1?.startsWith('INITIAL_POSITIONING') || !s2?.startsWith('INITIAL_POSITIONING'))
  throw new Error('both pages did not reach INITIAL_POSITIONING');
await page1.screenshot({ path: `${OUT}/m6-03-both-joined.png` });
log('BROWSER ACCEPTANCE PASSED');
await browser.close();
