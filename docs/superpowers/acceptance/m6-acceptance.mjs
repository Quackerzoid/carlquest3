/**
 * Milestone 6 acceptance (spec §9.6): TWO scripted colyseus.js clients against a
 * real Colyseus server (ws://localhost:2567, started with `npm run dev`) — the
 * M3/M4/M5 acceptance pattern, now genuinely two-player.
 *
 * Part 1 — full game, role-correct clients only:
 *   Client A CREATES the room with a 4-letter code (side A, bats first); client B
 *   JOINS by that code (side B). Every message is sent by its role-correct client:
 *   pitch from the fielding side, swing/runDecision from the batting side,
 *   confirmPositioning/readyForPlay from BOTH. Includes ONE deliberate wrong-role
 *   pitch (batting client pitches) and logs its structured `wrongRole` rejection.
 *   Runs to GAME_OVER, then demonstrates consented quit: B leaves → A receives
 *   `opponentLeft {side:'B'}` and the room disposes.
 *
 * Part 2 — drop → paused → reconnect, in a SECOND room:
 *   Both clients join, reach PLAY, B pitches (ball live and moving), then B's raw
 *   WebSocket is closed WITHOUT consent (`room.connection.transport.ws.close()` —
 *   colyseus.js 0.15 keeps the socket at connection.transport.ws). A observes
 *   `paused = true` and the ball position frozen across ≥1 s; a message sent while
 *   paused draws the structured `paused` rejection. B then reconnects with the
 *   reconnectionToken captured BEFORE the drop (`client.reconnect(token)`), the
 *   game unpauses and the ball resumes.
 *
 * Strategy notes inherited from m5-acceptance.mjs: side A lofts for half-rounders,
 * side B is played for one run-out demo then stop-at-post-1, so A wins; a live
 * full rounder remains unreachable under current tunables (see TUNING.md).
 */
import { Client } from 'colyseus.js';

const SEED = Number(process.argv[2] ?? 42);
const URL = 'ws://localhost:2567';
const POST_1 = { x: 11, z: 4 };
const BOWLER = { x: 0, z: 7.5 };
const MID_FIELD = { x: 0, z: 30 };

const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, timeoutMs = 30000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(15);
  }
}

const failures = [];

// ============================== PART 1: FULL GAME =============================
log('=== PART 1: full two-client game to GAME_OVER (role-correct senders only) ===');

const CODE = 'MSIX';
const clientA = new Client(URL);
const clientB = new Client(URL);
const roomA = await clientA.create('match', { code: CODE, seed: SEED });
log(`A created room ${roomA.roomId} with code ${CODE} (seed=${SEED})`);
await waitFor(() => roomA.state.sessionA === roomA.sessionId, 'A seated as side A');
log(`A seated: sessionA=${roomA.state.sessionA} (=A's sessionId), roomCode=${roomA.state.roomCode}`);
const roomB = await clientB.join('match', { code: CODE });
log(`B joined room ${roomB.roomId} by code ${CODE}`);
if (roomB.roomId !== roomA.roomId) failures.push('code join landed in a different room');
await waitFor(() => roomA.state.sessionB === roomB.sessionId, 'B seated as side B');
log(`B seated: sessionB=${roomA.state.sessionB} (=B's sessionId); connectedA=${roomA.state.connectedA} connectedB=${roomA.state.connectedB}`);

const tally = { caught: 0, runOut: 0, safe: 0, rounder: 0 };
const resolutions = [];
const rejections = [];
let opponentLeftSeen = null;
function wire(room, label) {
  room.onMessage('playOutcome', (r) => {
    if (label === 'A') {
      resolutions.push(r);
      tally[r.cause.kind] += 1;
      log(`playOutcome→${label}: ${JSON.stringify(r)}`);
    }
  });
  room.onMessage('rejected', (r) => {
    if (label === 'A') {
      rejections.push(r);
      log(`rejected→${label}: ${JSON.stringify(r)}`);
    }
  });
  room.onMessage('opponentLeft', (m) => {
    opponentLeftSeen = m;
    log(`opponentLeft→${label}: ${JSON.stringify(m)}`);
  });
}
wire(roomA, 'A');
wire(roomB, 'B');

let lastPhase = '';
let inningsSeen = 0;
let inningsSwitches = 0;
roomA.onStateChange((s) => {
  if (s.phase !== lastPhase) {
    log(`phase: ${lastPhase || '(joining)'} → ${s.phase} | A ${s.scoreHalvesA}½ – B ${s.scoreHalvesB}½ | innings ${s.inningsIndex + 1} | outs ${s.outs} | batting ${s.battingSide} | batter ${s.currentBatterId}${s.tiebreak ? ' | TIEBREAK' : ''}`);
    lastPhase = s.phase;
  }
});

// Role routing: creator A bats first; the FIELDING side pitches.
const batRoom = () => (roomA.state.battingSide === 'A' ? roomA : roomB);
const fieldRoom = () => (roomA.state.battingSide === 'A' ? roomB : roomA);
const batLabel = () => roomA.state.battingSide;

async function startPlay() {
  await waitFor(() => roomA.state.phase !== 'LOBBY', 'leave LOBBY');
  if (roomA.state.inningsIndex !== inningsSeen) {
    inningsSwitches += roomA.state.inningsIndex - inningsSeen;
    inningsSeen = roomA.state.inningsIndex;
  }
  if (roomA.state.phase === 'INITIAL_POSITIONING') {
    // BOTH players must confirm (single confirm holds the gate — Task 2).
    roomA.send('confirmPositioning');
    roomB.send('confirmPositioning');
    await waitFor(() => roomA.state.phase === 'PRE_PLAY', 'PRE_PLAY');
  }
  if (roomA.state.phase === 'PRE_PLAY') {
    roomA.send('readyForPlay');
    roomB.send('readyForPlay');
    await waitFor(() => roomA.state.phase === 'PLAY', 'PLAY');
  }
  if (roomA.state.phase !== 'PLAY') throw new Error(`startPlay stuck at ${roomA.state.phase}`);
}

/** One pitch → swing attempt, each message from its role-correct client (see m5). */
async function pitchSwing(target, aimY, decision) {
  const bat = batRoom();
  const before = resolutions.length;
  fieldRoom().send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
  await waitFor(() => bat.state.ballLive && bat.state.ball.z > 1, 'ball in flight', 10000);
  await waitFor(() => !bat.state.ballLive || bat.state.ball.z < 3.5, 'ball near plane', 10000);
  if (bat.state.ballLive) {
    const lead = 0.05;
    const cx = bat.state.ball.x + bat.state.ball.vx * lead;
    const cz = bat.state.ball.z + bat.state.ball.vz * lead;
    bat.send('swing', { timing: 0, aim: { x: target.x - cx, y: aimY, z: target.z - cz }, spinInput: 0 });
  }
  if (decision !== null) {
    const start = Date.now();
    while (Date.now() - start < 2500) {
      let live = false;
      bat.state.runners.forEach((r) => {
        if (r.running) live = true;
      });
      if (live) {
        bat.send('runDecision', { go: decision });
        break;
      }
      if (!bat.state.ballLive || bat.state.phase !== 'PLAY') break;
      await sleep(20);
    }
  }
  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (resolutions.length > before) return true;
    if (roomA.state.phase !== 'PLAY') return true;
    if (!roomA.state.ballLive) {
      await sleep(200);
      if (resolutions.length > before || roomA.state.phase !== 'PLAY') return true;
      return false;
    }
    await sleep(30);
  }
  throw new Error('play neither resolved nor respawned in 12s');
}

async function play(style) {
  await startPlay();
  const before = resolutions.length;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let done;
    if (style === 'loft') done = await pitchSwing(MID_FIELD, 1000, true);
    else if (style === 'runout') done = await pitchSwing(POST_1, 0, true);
    else done = await pitchSwing(BOWLER, 0, false);
    if (done) {
      await waitFor(() => roomA.state.phase !== 'PLAY', 'play resolution to sync', 15000);
      return;
    }
    log('missed swing — re-pitching (quiet respawn path exercised)');
  }
  throw new Error('could not connect a swing in 8 pitches');
}

// ONE deliberate wrong-role message: the BATTING client pitches (pitching is the
// fielding side's role) in the first PLAY — expect a structured `wrongRole` rejection.
await startPlay();
log(`wrong-role demo: batting side is ${batLabel()} — batting client sends 'pitch'`);
batRoom().send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
await waitFor(() => rejections.some((r) => r.reason === 'wrongRole'), "structured 'wrongRole' rejection", 5000);

let plays = 0;
const MAX_PLAYS = 140;
while (roomA.state.phase !== 'GAME_OVER' && plays < MAX_PLAYS) {
  const battingA = roomA.state.battingSide === 'A';
  const style = battingA ? 'loft' : tally.runOut === 0 ? 'runout' : 'stop';
  await play(style);
  plays += 1;
}

await waitFor(() => roomA.state.winner !== '', 'winner sync', 5000);
log('=== GAME OVER ===');
log(`plays driven: ${plays}; innings switches observed: ${inningsSwitches}`);
log(`final score: A ${roomA.state.scoreHalvesA}½ – B ${roomA.state.scoreHalvesB}½; winner: ${roomA.state.winner}; tiebreak: ${roomA.state.tiebreak}`);
log(`outcome tally: ${JSON.stringify(tally)}; rejections observed: ${rejections.length} (${rejections.map((r) => r.reason).join('; ')})`);

// Consented quit: B leaves deliberately → A must receive opponentLeft {side:'B'}
// and the room disposes (A is force-closed by the server).
log("consented-quit demo: B calls room.leave(true)");
let aClosed = false;
roomA.onLeave(() => {
  aClosed = true;
});
await roomB.leave(true);
await waitFor(() => opponentLeftSeen !== null, 'opponentLeft broadcast to A', 5000);
await waitFor(() => aClosed, 'A force-closed by room disposal', 5000);
log(`room disposed after consented quit (A connection closed); opponentLeft=${JSON.stringify(opponentLeftSeen)}`);

if (roomA.state.winner === '') failures.push('no winner');
if (tally.caught === 0) failures.push('no caught out');
if (tally.runOut === 0) failures.push('no run-out');
if (!resolutions.some((r) => r.scoreDeltaHalves === 1)) failures.push('no half-rounder banked');
if (inningsSwitches < 3) failures.push(`only ${inningsSwitches} innings switches`);
if (!rejections.some((r) => r.reason === 'wrongRole')) failures.push('no wrongRole rejection');
if (opponentLeftSeen?.side !== 'B') failures.push('opponentLeft missing or wrong side');

// ==================== PART 2: DROP → PAUSED → RECONNECT =======================
log('=== PART 2: second room — non-consented drop → paused → reconnect → resumed ===');

const CODE2 = 'RCON';
const client2A = new Client(URL);
const client2B = new Client(URL);
const r2A = await client2A.create('match', { code: CODE2, seed: SEED });
const r2B = await client2B.join('match', { code: CODE2 });
log(`second room ${r2A.roomId} (code ${CODE2}): A=${r2A.sessionId}, B=${r2B.sessionId}`);

const rejections2 = [];
r2A.onMessage('rejected', (r) => {
  rejections2.push(r);
  log(`rejected→A: ${JSON.stringify(r)}`);
});
r2A.onMessage('playOutcome', () => {});
r2B.onMessage('playOutcome', () => {});
r2B.onMessage('rejected', () => {});
r2A.onMessage('opponentLeft', (m) => log(`opponentLeft→A: ${JSON.stringify(m)}`));

await waitFor(() => r2A.state.phase === 'INITIAL_POSITIONING', 'second room leaves LOBBY');
r2A.send('confirmPositioning');
r2B.send('confirmPositioning');
await waitFor(() => r2A.state.phase === 'PRE_PLAY', 'second room PRE_PLAY');
r2A.send('readyForPlay');
r2B.send('readyForPlay');
await waitFor(() => r2A.state.phase === 'PLAY', 'second room PLAY');

// B (fielding — A bats first) pitches so the ball is live and MOVING when B drops.
r2B.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
await waitFor(() => r2A.state.ballLive && r2A.state.ball.z > 1 && r2A.state.ball.z < 20, 'ball mid-flight', 10000);

// Capture the reconnection token BEFORE dropping, then close the RAW socket —
// room.leave() would send a consented close; this simulates a network drop.
const token = r2B.reconnectionToken;
log(`B reconnectionToken captured: ${token}`);
r2B.connection.transport.ws.close();
log('B raw WebSocket closed (non-consented drop)');

await waitFor(() => r2A.state.paused === true, 'paused = true synced to A', 5000);
const frozen1 = { x: r2A.state.ball.x, z: r2A.state.ball.z, live: r2A.state.ballLive };
log(`paused: connectedB=${r2A.state.connectedB}, ballLive=${frozen1.live}, ball at x=${frozen1.x.toFixed(4)} z=${frozen1.z.toFixed(4)}`);
await sleep(1200);
const frozen2 = { x: r2A.state.ball.x, z: r2A.state.ball.z };
log(`after 1.2s still paused=${r2A.state.paused}: ball at x=${frozen2.x.toFixed(4)} z=${frozen2.z.toFixed(4)}`);
if (frozen1.x !== frozen2.x || frozen1.z !== frozen2.z) failures.push('ball moved while paused');
if (r2A.state.paused !== true) failures.push('pause did not hold');

// A message sent while paused draws the structured `paused` rejection.
r2A.send('swing', { timing: 0, aim: { x: 0, y: 0, z: 1 }, spinInput: 0 });
await waitFor(() => rejections2.some((r) => r.reason === 'paused'), "structured 'paused' rejection", 5000);

// Reconnect with the pre-drop token: game unpauses and the sim resumes.
const client2B2 = new Client(URL);
const r2B2 = await client2B2.reconnect(token);
log(`B reconnected: sessionId=${r2B2.sessionId}`);
r2B2.onMessage('playOutcome', () => {});
r2B2.onMessage('rejected', () => {});
r2B2.onMessage('opponentLeft', () => {});
await waitFor(() => r2A.state.paused === false, 'unpaused after reconnect', 5000);
log(`unpaused: connectedA=${r2A.state.connectedA} connectedB=${r2A.state.connectedB}`);
await waitFor(
  () => !r2A.state.ballLive || r2A.state.ball.z !== frozen2.z || r2A.state.ball.x !== frozen2.x,
  'simulation resumed (ball moves or play ends)',
  5000,
);
log(`resumed: ballLive=${r2A.state.ballLive}, ball at x=${r2A.state.ball.x.toFixed(4)} z=${r2A.state.ball.z.toFixed(4)}`);

if (!rejections2.some((r) => r.reason === 'paused')) failures.push('no paused rejection');

// Clean up the second room via a consented quit (also disposes it).
await r2A.leave(true);
await sleep(300);

if (failures.length > 0) {
  log(`ACCEPTANCE FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
log('ACCEPTANCE PASSED (both parts)');
process.exit(0);
