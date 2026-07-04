/**
 * Milestone 5 acceptance (spec §9.5): drive a COMPLETE single-player game over a
 * real Colyseus server (ws://localhost:2567, started with `npm run dev`) from a
 * scripted colyseus.js client — the M3/M4 acceptance pattern.
 *
 * Modes:
 *   node m5-acceptance.mjs game <seed>      — full game to GAME_OVER with a winner:
 *     side A lofts for half-rounders, side B is played for catches / stop-at-post-1
 *     (0 halves), so A wins. Logs every phase transition, every PlayResolution,
 *     one deliberate out-of-phase rejection, and the outcome-kind tally.
 *   node m5-acceptance.mjs tiebreak <seed>  — every play is scoreless, forcing a
 *     0–0 tie after both innings pairs → sudden-death tiebreak pairs; A then lofts
 *     on its tiebreak play, B is caught/stopped → first differential pair wins.
 *
 * NOTE (logged deviation, mirrored in MatchRoom.test.ts): a live full ROUNDER is
 * unreachable with current tunables — the post circuit is ~47.4 m at ~6.35 m/s
 * (Carl, speed 7) ≈ 7.5 s, but GAME.PLAY_TIMEOUT_S = 6 ends the play first. The
 * rounder path (cause {kind:'rounder'}, +2 halves, batter re-queues) is covered by
 * RulesModule unit tests; TUNING.md carries the retune suggestion.
 */
import { Client } from 'colyseus.js';

const MODE = process.argv[2] ?? 'game';
const SEED = Number(process.argv[3] ?? 42);
const POST_1 = { x: 11, z: 4 };
const BOWLER = { x: 0, z: 7.5 };
const MID_FIELD = { x: 0, z: 30 };

const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const client = new Client('ws://localhost:2567');
const room = await client.joinOrCreate('match', { seed: SEED });
log(`joined room ${room.roomId} (mode=${MODE}, seed=${SEED})`);

const tally = { caught: 0, runOut: 0, safe: 0, rounder: 0 };
const resolutions = [];
let lastResolution = null;
let rejections = 0;
room.onMessage('playOutcome', (r) => {
  lastResolution = r;
  resolutions.push(r);
  tally[r.cause.kind] += 1;
  log(`playOutcome: ${JSON.stringify(r)}`);
});
room.onMessage('rejected', (r) => {
  rejections += 1;
  log(`rejected: ${JSON.stringify(r)}`);
});

let lastPhase = '';
let inningsSwitches = 0;
let sawTiebreak = false;
room.onStateChange((s) => {
  if (s.phase !== lastPhase) {
    log(`phase: ${lastPhase || '(joining)'} → ${s.phase} | A ${s.scoreHalvesA}½ – B ${s.scoreHalvesB}½ | innings ${s.inningsIndex + 1} | outs ${s.outs} | batting ${s.battingSide} | batter ${s.currentBatterId}${s.tiebreak ? ' | TIEBREAK' : ''}`);
    lastPhase = s.phase;
  }
  if (s.tiebreak && !sawTiebreak) {
    sawTiebreak = true;
    log('=== SUDDEN-DEATH TIEBREAK ENTERED ===');
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, timeoutMs = 30000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what} (phase=${room.state.phase})`);
    await sleep(15);
  }
}

let inningsSeen = 0;
async function startPlay() {
  await waitFor(() => room.state.phase !== 'LOBBY', 'leave LOBBY');
  if (room.state.inningsIndex !== inningsSeen) {
    inningsSwitches += room.state.inningsIndex - inningsSeen;
    inningsSeen = room.state.inningsIndex;
  }
  if (room.state.phase === 'INITIAL_POSITIONING') {
    room.send('confirmPositioning');
    await waitFor(() => room.state.phase === 'PRE_PLAY', 'PRE_PLAY');
  }
  if (room.state.phase === 'PRE_PLAY') {
    room.send('readyForPlay');
    await waitFor(() => room.state.phase === 'PLAY', 'PLAY');
  }
  if (room.state.phase !== 'PLAY') throw new Error(`startPlay stuck at ${room.state.phase}`);
}

/**
 * One pitch → swing attempt. Swings when the synced ball is close to the batting
 * plane, aiming at `target` from a one-patch lead prediction. Returns true if the
 * play resolved (playOutcome received); false if the swing missed and the server
 * quietly respawned the ball (still PLAY, ballLive false) — caller re-pitches.
 */
async function pitchSwing(target, aimY, decision) {
  const before = resolutions.length;
  room.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
  await waitFor(() => room.state.ballLive && room.state.ball.z > 1, 'ball in flight', 10000);
  await waitFor(() => !room.state.ballLive || room.state.ball.z < 3.5, 'ball near plane', 10000);
  if (room.state.ballLive) {
    const lead = 0.05; // one patch interval of prediction
    const cx = room.state.ball.x + room.state.ball.vx * lead;
    const cz = room.state.ball.z + room.state.ball.vz * lead;
    room.send('swing', { timing: 0, aim: { x: target.x - cx, y: aimY, z: target.z - cz }, spinInput: 0 });
  }
  if (decision !== null) {
    // The decision is only valid once contact has spawned a live runner — wait
    // for one to appear in the synced state (a missed swing never produces one).
    const start = Date.now();
    while (Date.now() - start < 2500) {
      let live = false;
      room.state.runners.forEach((r) => {
        if (r.running) live = true;
      });
      if (live) {
        room.send('runDecision', { go: decision });
        break;
      }
      if (!room.state.ballLive || room.state.phase !== 'PLAY') break;
      await sleep(20);
    }
  }
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (resolutions.length > before) return true;
    if (room.state.phase !== 'PLAY') return true;
    if (!room.state.ballLive) {
      // Either resolved (handled above next poll) or a missed swing respawn.
      await sleep(200);
      if (resolutions.length > before || room.state.phase !== 'PLAY') return true;
      return false;
    }
    await sleep(30);
  }
  throw new Error('play neither resolved nor respawned in 12s');
}

/** Drive one full play of the given style, re-pitching on missed swings. */
async function play(style) {
  await startPlay();
  const before = resolutions.length;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let done;
    if (style === 'loft') done = await pitchSwing(MID_FIELD, 1000, true);
    else if (style === 'runout') done = await pitchSwing(POST_1, 0, true);
    else done = await pitchSwing(BOWLER, 0, false); // 'stop': flat at the bowler, halt at post 1
    if (done) {
      await waitFor(() => room.state.phase !== 'PLAY', 'play resolution to sync', 15000);
      return resolutions.length > before ? resolutions[resolutions.length - 1] : null;
    }
    log('missed swing — re-pitching (quiet respawn path exercised)');
  }
  throw new Error('could not connect a swing in 8 pitches');
}

// One deliberate out-of-phase message: pitch during INITIAL_POSITIONING/PRE_PLAY.
await waitFor(() => room.state.phase === 'INITIAL_POSITIONING', 'INITIAL_POSITIONING');
room.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
await waitFor(() => rejections > 0, 'out-of-phase rejection broadcast', 5000);

let plays = 0;
const MAX_PLAYS = 140;
while (room.state.phase !== 'GAME_OVER' && plays < MAX_PLAYS) {
  const battingA = room.state.battingSide === 'A';
  let style;
  if (MODE === 'tiebreak') {
    // Scoreless everywhere until the tiebreak, then A lofts for the differential.
    style = room.state.tiebreak && battingA ? 'loft' : 'stop';
  } else {
    // Side A lofts (banks half-rounders); side B: one run-out demo, then stops.
    style = battingA ? 'loft' : tally.runOut === 0 ? 'runout' : 'stop';
  }
  await play(style);
  plays += 1;
}

await waitFor(() => room.state.winner !== '', 'winner sync', 5000);
log('=== GAME OVER ===');
log(`plays driven: ${plays}; innings switches observed: ${inningsSwitches}`);
log(`final score: A ${room.state.scoreHalvesA}½ – B ${room.state.scoreHalvesB}½; winner: ${room.state.winner}; tiebreak: ${room.state.tiebreak}`);
log(`outcome tally: ${JSON.stringify(tally)}; rejections observed: ${rejections}`);
log(`lastOutcome schema field: ${room.state.lastOutcome}`);

if (MODE === 'game') {
  // Rematch demonstration (spec §2.8): GAME_OVER → INITIAL_POSITIONING, zeroed.
  room.send('rematch');
  await waitFor(() => room.state.phase === 'INITIAL_POSITIONING', 'rematch reset', 5000);
  log(`rematch: phase=${room.state.phase}, A ${room.state.scoreHalvesA}½ – B ${room.state.scoreHalvesB}½, winner='${room.state.winner}', innings ${room.state.inningsIndex + 1}`);
}

const failures = [];
if (room.state.winner === '' && lastResolution === null) failures.push('no winner');
if (MODE === 'game') {
  if (tally.caught === 0) failures.push('no caught out');
  if (tally.runOut === 0) failures.push('no run-out');
  if (!resolutions.some((r) => r.scoreDeltaHalves === 1)) failures.push('no half-rounder banked');
  if (inningsSwitches < 3) failures.push(`only ${inningsSwitches} innings switches`);
  if (rejections === 0) failures.push('no rejection observed');
} else if (!sawTiebreak) {
  failures.push('tiebreak never entered');
}
if (failures.length > 0) {
  log(`ACCEPTANCE FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
log(`ACCEPTANCE PASSED (${MODE})`);
process.exit(0);
