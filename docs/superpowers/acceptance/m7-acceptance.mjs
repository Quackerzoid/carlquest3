/**
 * Milestone 7 acceptance (spec §9.7): TWO scripted colyseus.js clients against a
 * real Colyseus server (ws://localhost:2567, started with `npm run dev`) — the
 * M6 harness extended with the REAL draft.
 *
 * Sequence:
 *  1. A creates by 4-letter code, B joins by it; the room rests in DRAFT.
 *  2. One deliberate OUT-OF-TURN pick (B picks on A's turn) → structured
 *     `rejected {reason:'wrongRole'}` to the offender only.
 *  3. Full alternating table-order draft (each side picks the first remaining
 *     roster id on its turn), including one deliberate TAKEN-ID pick (B re-picks
 *     carl) → prose rejection, turn preserved.
 *  4. Asserts the exact drafted squads (A: carl,laurie,joel,jonty,joe; B: kian,
 *     josh,darcy,robbie,ricy — pick order = batting order), the whale left
 *     undrafted, phase → INITIAL_POSITIONING.
 *  5. setPitcher: default bowler is kian (B's best arm); a batting-side attempt
 *     draws `wrongRole`; the fielding side nominates ricy (currentPitcherId
 *     flips, ricy stands on FIELDING_POSITIONS[0] = the bowling square), then
 *     restores kian.
 *  6. Full game to GAME_OVER (the M6 role-correct play loop). At EVERY innings
 *     switch it asserts the fielding five are exactly the new fielding side's
 *     drafted squad and the pitcher is that side's DEFAULT (A fields → joel;
 *     B fields again → kian re-derived). Also asserts the whale never bats.
 *
 * A real verifier: failures accumulate and the process exits non-zero on any.
 * Log: m7-acceptance.txt (`.txt` because `*.log` is gitignored).
 */
import { Client } from 'colyseus.js';

const SEED = Number(process.argv[2] ?? 42);
const URL = 'ws://localhost:2567';
const POST_1 = { x: 11, z: 4 };
const BOWLER = { x: 0, z: 7.5 }; // FIELDING_POSITIONS[0] = BOWLING_SQUARE
const MID_FIELD = { x: 0, z: 30 };

// Roster table order (shared/src/characters.ts) — first-remaining picks make the
// draft deterministic: A carl, B kian, A laurie, B josh, A joel, B darcy,
// A jonty, B robbie, A joe, B ricy; the whale is left undrafted.
const TABLE_IDS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy', 'whale'];
const EXPECT_A = ['carl', 'laurie', 'joel', 'jonty', 'joe'];
const EXPECT_B = ['kian', 'josh', 'darcy', 'robbie', 'ricy'];
// Default pitcher = highest pitch stat, tie to the earlier pick:
// A: joel (9); B: kian (8, beats ricy's 8 on pick order).
const DEFAULT_PITCHER = { A: 'joel', B: 'kian' };

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
function check(cond, what) {
  if (cond) {
    log(`OK: ${what}`);
  } else {
    failures.push(what);
    log(`FAIL: ${what}`);
  }
}

// ============================ SETUP: CREATE + JOIN ============================
const CODE = 'MSVN';
const clientA = new Client(URL);
const clientB = new Client(URL);
const roomA = await clientA.create('match', { code: CODE, seed: SEED });
log(`A created room ${roomA.roomId} with code ${CODE} (seed=${SEED})`);
await waitFor(() => roomA.state.sessionA === roomA.sessionId, 'A seated as side A');
const roomB = await clientB.join('match', { code: CODE });
log(`B joined room ${roomB.roomId} by code ${CODE}`);
check(roomB.roomId === roomA.roomId, 'code join landed in the same room');
await waitFor(() => roomA.state.sessionB === roomB.sessionId, 'B seated as side B');

const tally = { caught: 0, runOut: 0, safe: 0, rounder: 0 };
const resolutions = [];
const rejectionsA = [];
const rejectionsB = [];
roomA.onMessage('playOutcome', (r) => {
  resolutions.push(r);
  tally[r.cause.kind] += 1;
  log(`playOutcome→A: ${JSON.stringify(r)}`);
});
roomB.onMessage('playOutcome', () => {});
roomA.onMessage('rejected', (r) => {
  rejectionsA.push(r);
  log(`rejected→A: ${JSON.stringify(r)}`);
});
roomB.onMessage('rejected', (r) => {
  rejectionsB.push(r);
  log(`rejected→B: ${JSON.stringify(r)}`);
});
roomA.onMessage('opponentLeft', (m) => log(`opponentLeft→A: ${JSON.stringify(m)}`));
roomB.onMessage('opponentLeft', () => {});

let lastPhase = '';
const battersSeen = new Set();
roomA.onStateChange((s) => {
  if (s.currentBatterId !== '') battersSeen.add(s.currentBatterId);
  if (s.phase !== lastPhase) {
    log(`phase: ${lastPhase || '(joining)'} → ${s.phase} | A ${s.scoreHalvesA}½ – B ${s.scoreHalvesB}½ | innings ${s.inningsIndex + 1} | outs ${s.outs} | batting ${s.battingSide} | batter ${s.currentBatterId}${s.tiebreak ? ' | TIEBREAK' : ''}`);
    lastPhase = s.phase;
  }
});

// ================================ PART 1: DRAFT ===============================
log('=== PART 1: alternating draft (A first), with wrong-turn + taken-id rejections ===');
await waitFor(() => roomA.state.phase === 'DRAFT', 'room rests in DRAFT once both are seated');
check(roomA.state.draftTurn === 'A', `draft opens on side A's turn (got '${roomA.state.draftTurn}')`);
check(roomA.state.draftRemaining.length === 11, `full 11-character pool offered (got ${roomA.state.draftRemaining.length})`);

// Deliberate OUT-OF-TURN pick: B picks while it is A's turn → structured wrongRole.
log("wrong-turn demo: B sends draftPick {id:'kian'} on A's turn");
roomB.send('draftPick', { id: 'kian' });
await waitFor(() => rejectionsB.some((r) => r.message === 'draftPick' && r.reason === 'wrongRole'), "structured 'wrongRole' draftPick rejection to B", 5000);
check(roomA.state.draftTurn === 'A', 'turn unchanged after the out-of-turn pick');
check(roomA.state.squadBIds.length === 0, 'nothing drafted by the rejected pick');

// A's first pick, then a deliberate TAKEN-ID pick: B re-picks carl → prose rejection.
roomA.send('draftPick', { id: 'carl' });
await waitFor(() => roomA.state.squadAIds.length === 1, "A's first pick synced", 5000);
check(roomA.state.squadAIds[0] === 'carl', 'A drafted carl first');
check(roomA.state.draftTurn === 'B', "turn alternated to B after A's pick");
log("taken-id demo: B sends draftPick {id:'carl'} (already A's)");
const rejB0 = rejectionsB.length;
roomB.send('draftPick', { id: 'carl' });
await waitFor(() => rejectionsB.length > rejB0, 'taken-id draftPick rejection to B', 5000);
const takenRej = rejectionsB[rejectionsB.length - 1];
check(
  takenRej.message === 'draftPick' && takenRej.reason !== 'wrongRole' && takenRej.reason !== 'paused',
  `taken-id pick rejected with a prose reason (got '${takenRej.reason}')`,
);
check(roomA.state.draftTurn === 'B', 'turn preserved after the taken-id rejection');

// Complete the draft: whichever side is on turn picks the first remaining table id.
while (roomA.state.draftTurn !== '') {
  const turn = roomA.state.draftTurn;
  const picked = new Set([...roomA.state.squadAIds, ...roomA.state.squadBIds]);
  const id = TABLE_IDS.find((c) => !picked.has(c));
  const room = turn === 'A' ? roomA : roomB;
  const count = picked.size;
  log(`${turn} picks ${id}`);
  room.send('draftPick', { id });
  await waitFor(
    () => roomA.state.squadAIds.length + roomA.state.squadBIds.length > count || roomA.state.draftTurn === '',
    `pick ${count + 1} synced`,
    5000,
  );
}

check(JSON.stringify([...roomA.state.squadAIds]) === JSON.stringify(EXPECT_A), `squad A = ${EXPECT_A.join(',')} (got ${[...roomA.state.squadAIds].join(',')})`);
check(JSON.stringify([...roomA.state.squadBIds]) === JSON.stringify(EXPECT_B), `squad B = ${EXPECT_B.join(',')} (got ${[...roomA.state.squadBIds].join(',')})`);
check(JSON.stringify([...roomA.state.draftRemaining]) === JSON.stringify(['whale']), `the whale is left undrafted (remaining: ${[...roomA.state.draftRemaining].join(',')})`);
await waitFor(() => roomA.state.phase === 'INITIAL_POSITIONING', 'draft completion advances to INITIAL_POSITIONING', 5000);

// ============================ PART 2: SET PITCHER =============================
log('=== PART 2: pitcher nomination (fielding side only) ===');

/** Assert the on-field five are exactly `side`'s drafted squad with `pitcherId` on the bowling square. */
function checkFielding(side, pitcherId, label) {
  const expected = [...(side === 'A' ? EXPECT_A : EXPECT_B)].sort();
  const keys = [...roomA.state.fielders.keys()].sort();
  check(JSON.stringify(keys) === JSON.stringify(expected), `${label}: fielders are ${side}'s five (${expected.join(',')}) — got ${keys.join(',')}`);
  check(roomA.state.currentPitcherId === pitcherId, `${label}: currentPitcherId = ${pitcherId} (got '${roomA.state.currentPitcherId}')`);
  const bowler = roomA.state.fielders.get(pitcherId);
  check(
    bowler !== undefined && Math.abs(bowler.x - BOWLER.x) < 1e-6 && Math.abs(bowler.z - BOWLER.z) < 1e-6,
    `${label}: ${pitcherId} stands on FIELDING_POSITIONS[0] (${BOWLER.x}, ${BOWLER.z})`,
  );
}

checkFielding('B', 'kian', 'innings 1 default');

// Batting side (A) may not nominate: structured wrongRole.
log("wrong-role demo: batting side A sends setPitcher {id:'joel'}");
roomA.send('setPitcher', { id: 'joel' });
await waitFor(() => rejectionsA.some((r) => r.message === 'setPitcher' && r.reason === 'wrongRole'), "structured 'wrongRole' setPitcher rejection to A", 5000);
check(roomA.state.currentPitcherId === 'kian', 'pitcher unchanged by the batting-side attempt');

// Fielding side (B) nominates ricy: pitcher flips and takes the bowling square.
log("fielding side B sends setPitcher {id:'ricy'}");
roomB.send('setPitcher', { id: 'ricy' });
await waitFor(() => roomA.state.currentPitcherId === 'ricy', 'nominated pitcher synced', 5000);
checkFielding('B', 'ricy', 'after nomination');

// Restore the default for the game loop (also proves re-nomination works).
roomB.send('setPitcher', { id: 'kian' });
await waitFor(() => roomA.state.currentPitcherId === 'kian', 'pitcher restored to kian', 5000);
checkFielding('B', 'kian', 'after re-nomination');

// ==================== PART 3: FULL GAME, FIELDING PER SIDE ====================
log('=== PART 3: full game — per-side fielding five + default pitcher at every innings switch ===');

const batRoom = () => (roomA.state.battingSide === 'A' ? roomA : roomB);
const fieldRoom = () => (roomA.state.battingSide === 'A' ? roomB : roomA);

let inningsSeen = 0;
let inningsSwitches = 0;

async function startPlay() {
  await waitFor(() => roomA.state.phase !== 'LOBBY' && roomA.state.phase !== 'DRAFT', 'leave LOBBY/DRAFT');
  if (roomA.state.inningsIndex !== inningsSeen) {
    inningsSwitches += roomA.state.inningsIndex - inningsSeen;
    inningsSeen = roomA.state.inningsIndex;
    // The fielding side flipped: the on-field five must be the NEW side's squad
    // with that side's DEFAULT pitcher (nominations do not survive a side change).
    const fieldingSide = roomA.state.battingSide === 'A' ? 'B' : 'A';
    checkFielding(fieldingSide, DEFAULT_PITCHER[fieldingSide], `innings ${inningsSeen + 1} switch (fielding ${fieldingSide})`);
  }
  if (roomA.state.phase === 'INITIAL_POSITIONING') {
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

/** One pitch → swing attempt, each message from its role-correct client (M6 loop). */
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
log(`outcome tally: ${JSON.stringify(tally)}`);
log(`batters seen: ${[...battersSeen].sort().join(',')}`);

check(roomA.state.winner !== '', 'game reached GAME_OVER with a winner');
check(inningsSwitches >= 3, `at least one full innings each way and back (${inningsSwitches} switches)`);
check(tally.caught > 0, 'at least one caught out');
check(tally.runOut > 0, 'at least one run-out');
check(resolutions.some((r) => r.scoreDeltaHalves >= 1), 'at least one half-rounder banked');
check(!battersSeen.has('whale'), 'the undrafted whale never batted');
check([...battersSeen].every((id) => EXPECT_A.includes(id) || EXPECT_B.includes(id)), 'every batter came from a drafted squad');

await roomB.leave(true);
await sleep(300);

if (failures.length > 0) {
  log(`ACCEPTANCE FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
log('ACCEPTANCE PASSED');
process.exit(0);
