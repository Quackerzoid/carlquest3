/**
 * Auto-play redesign acceptance: scripted colyseus.js clients against a real
 * Colyseus server running this worktree's code.
 *
 * Port note (2026-07-05 run): the canonical `npm run dev` pair (5173/2567) was
 * held by a stale, UNKILLABLE node pair from another session (taskkill Access
 * denied even elevated — see the project log), so the recorded run started the
 * SAME app config on port 2568 (`npx tsx server/serve2568.tmp.ts`, a five-line
 * harness-only entry mirroring server/src/index.ts). Pass the URL as argv[3]
 * to run against a normal `npm run dev` server:
 *   node docs/superpowers/acceptance/autoplay-acceptance.mjs 1 ws://localhost:2567
 *
 * ROOM 1 (code ATPL, seeded): the core redesign acceptance.
 *  1. Create/join by code, full table-order draft (A: carl,laurie,joel,jonty,joe;
 *     B: kian,josh,darcy,robbie,ricy; kian bowls innings 1).
 *  2. Full game to GAME_OVER with ZERO play messages sent by either client —
 *     the clients only ever send confirmPositioning/readyForPlay; every pitch,
 *     swing, run decision and catch happens as a server dice beat.
 *  3. Roll broadcast collector, asserted per play: the FIRST roll of every play
 *     is a pitch; every swing roll immediately follows a pitch roll; every
 *     re-pitch follows a FAILED swing; run/catch rolls only appear after a
 *     successful (contact) swing; per-play counts logged.
 *  4. COUNTER-CLOCKWISE orientation, asserted from the runner SCHEMA: the very
 *     first runner's opening leg heads into NEGATIVE x (post 1 sits at x = −11
 *     after the user-directed mirror; the old clockwise field had it at +11),
 *     and the deepest x they reach before first parking is well negative (the
 *     post-1/post-2 region). Note: schema atPost is −1 while RUNNING, and the
 *     runner AI usually runs straight through posts 1–2 to park at post 3
 *     (x = +3), so "first post ARRIVAL x < 0" is not a property the AI
 *     guarantees — the opening-leg direction pins the orientation instead
 *     (first observed run sample ≥3 m from the batting square, plus min-x over
 *     the whole first run).
 *
 * ROOM 2 (code ATPP, seeded): tombstones + pause.
 *  5. Tombstone rejections, exact prose, each from the role that USED to send
 *     that message: pitch from the fielding side, swing and runDecision from
 *     the batting side → all rejected with exactly 'plays resolve automatically'.
 *  6. Pause freezes the dice: mid-play raw-socket drop (M6 technique) →
 *     paused=true, ZERO roll broadcasts and a frozen ball across ≥1.2 s real
 *     time; reconnect with the pre-drop token → unpaused and the rolls resume.
 *
 * A real verifier: failures accumulate and the process exits non-zero on any.
 * Log: autoplay-acceptance.txt (`.txt` because `*.log` is gitignored).
 */
import { Client } from 'colyseus.js';

const SEED = Number(process.argv[2] ?? 1);
const URL = process.argv[3] ?? 'ws://localhost:2568';
const TOMBSTONE = 'plays resolve automatically';

// Roster table order (shared/src/characters.ts) — first-remaining picks make the
// draft deterministic: A carl,laurie,joel,jonty,joe; B kian,josh,darcy,robbie,ricy.
const TABLE_IDS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy', 'whale'];
const EXPECT_A = ['carl', 'laurie', 'joel', 'jonty', 'joe'];
const EXPECT_B = ['kian', 'josh', 'darcy', 'robbie', 'ricy'];

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

/** Connect two clients into one room by code and wire the shared listeners. */
async function openRoom(code, options) {
  const clientA = new Client(URL);
  const clientB = new Client(URL);
  const roomA = await clientA.create('match', { code, ...options });
  await waitFor(() => roomA.state.sessionA === roomA.sessionId, 'A seated as side A');
  const roomB = await clientB.join('match', { code });
  check(roomB.roomId === roomA.roomId, `code join landed in room ${roomA.roomId}`);
  await waitFor(() => roomA.state.sessionB === roomB.sessionId, 'B seated as side B');

  const h = { roomA, roomB, clientB, resolutions: [], rejections: { A: [], B: [] }, rolls: [] };
  roomA.onMessage('playOutcome', (r) => {
    h.resolutions.push(r);
    log(`playOutcome→A: ${JSON.stringify(r)}`);
  });
  roomB.onMessage('playOutcome', () => {});
  roomA.onMessage('rejected', (r) => {
    h.rejections.A.push(r);
    log(`rejected→A: ${JSON.stringify(r)}`);
  });
  roomB.onMessage('rejected', (r) => {
    h.rejections.B.push(r);
    log(`rejected→B: ${JSON.stringify(r)}`);
  });
  // The roll stream: every automated contest's dice moment, in broadcast order.
  roomA.onMessage('roll', (e) => h.rolls.push(e));
  roomB.onMessage('roll', () => {});
  roomA.onMessage('opponentLeft', () => {});
  roomB.onMessage('opponentLeft', () => {});

  let lastPhase = '';
  roomA.onStateChange((s) => {
    if (s.phase !== lastPhase) {
      log(`phase: ${lastPhase || '(joining)'} → ${s.phase} | A ${s.scoreHalvesA}½ – B ${s.scoreHalvesB}½ | innings ${s.inningsIndex + 1} | outs ${s.outs} | batting ${s.battingSide} | batter ${s.currentBatterId}`);
      lastPhase = s.phase;
    }
  });

  /** Clean table-order draft: whichever side is on turn picks the first remaining id. */
  h.draft = async () => {
    await waitFor(() => roomA.state.phase === 'DRAFT', 'room rests in DRAFT once both are seated');
    while (roomA.state.draftTurn !== '') {
      const picked = new Set([...roomA.state.squadAIds, ...roomA.state.squadBIds]);
      const id = TABLE_IDS.find((c) => !picked.has(c));
      const room = roomA.state.draftTurn === 'A' ? roomA : roomB;
      const count = picked.size;
      room.send('draftPick', { id });
      await waitFor(
        () => roomA.state.squadAIds.length + roomA.state.squadBIds.length > count || roomA.state.draftTurn === '',
        `pick ${count + 1} synced`,
        5000,
      );
    }
    check(JSON.stringify([...roomA.state.squadAIds]) === JSON.stringify(EXPECT_A), `squad A = ${EXPECT_A.join(',')}`);
    check(JSON.stringify([...roomA.state.squadBIds]) === JSON.stringify(EXPECT_B), `squad B = ${EXPECT_B.join(',')}`);
    await waitFor(() => roomA.state.phase === 'INITIAL_POSITIONING', 'draft completion advances to INITIAL_POSITIONING', 5000);
  };

  /** confirm/ready both sides into PLAY (the ONLY messages the game loop ever sends). */
  h.startPlay = async () => {
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
  };

  /** Wait for the NEXT rejection to the given side for `message` and return it. */
  h.expectRejection = async (side, message, what) => {
    const list = h.rejections[side];
    const before = list.length;
    await waitFor(() => list.length > before && list[list.length - 1].message === message, what, 5000);
    return list[list.length - 1];
  };

  return h;
}

/**
 * Per-play roll-sequence sanity (redesign contract): the first roll is a pitch;
 * a swing immediately follows every pitch; a re-pitch only follows a FAILED
 * swing; run/catch rolls only appear after the successful (contact) swing.
 */
function checkRollSequence(playRolls, label) {
  if (playRolls.length === 0) {
    failures.push(`${label}: no rolls broadcast`);
    return;
  }
  let ok = playRolls[0].contest === 'pitch';
  let why = ok ? '' : `first roll is '${playRolls[0].contest}', not pitch`;
  let contactSeen = false;
  for (let i = 0; i < playRolls.length && ok; i += 1) {
    const r = playRolls[i];
    if (r.contest === 'pitch') {
      if (i > 0 && !(playRolls[i - 1].contest === 'swing' && playRolls[i - 1].success === false)) {
        ok = false;
        why = `re-pitch at index ${i} not preceded by a failed swing`;
      }
      if (contactSeen) {
        ok = false;
        why = `pitch at index ${i} after contact`;
      }
    } else if (r.contest === 'swing') {
      if (playRolls[i - 1]?.contest !== 'pitch') {
        ok = false;
        why = `swing at index ${i} does not follow a pitch`;
      }
      if (r.success) contactSeen = true;
    } else if (!contactSeen) {
      ok = false;
      why = `'${r.contest}' roll at index ${i} before any contact`;
    }
  }
  const counts = playRolls.reduce((acc, r) => ((acc[r.contest] = (acc[r.contest] ?? 0) + 1), acc), {});
  check(ok, `${label}: roll sequence sane (${playRolls.length} rolls: ${JSON.stringify(counts)})${ok ? '' : ` — ${why}`}`);
}

// ==================== ROOM 1: full auto-played game, zero play messages ====================
log(`=== ROOM 1 (seed ${SEED}): full game to GAME_OVER — the clients only confirm/ready ===`);
{
  const h = await openRoom('ATPL', { seed: SEED });
  await h.draft();
  const { roomA } = h;

  // Counter-clockwise watcher (schema-level): the FIRST runner ever observed —
  // the opening play's batter-runner leaving the batting square — must head
  // into NEGATIVE x (post 1 = −11 after the mirror). Tracked: the first sample
  // ≥3 m out from the square, the minimum x reached before first parking, and
  // the first parked post arrival (for the log; the AI usually runs through to
  // post 3, so the arrival post is not orientation evidence by itself).
  let firstRunnerId = null;
  let firstLeg = null; // first sample ≥3 m out on the opening run
  let minX = Infinity; // deepest x while the first runner runs, pre-park
  let firstParked = null;
  const pollRunners = () => {
    roomA.state.runners.forEach((r, id) => {
      if (firstRunnerId === null) firstRunnerId = id;
      if (id !== firstRunnerId || firstParked !== null) return;
      if (r.running) {
        minX = Math.min(minX, r.x);
        if (firstLeg === null && Math.hypot(r.x, r.z) >= 3) firstLeg = { id, x: r.x, z: r.z };
      }
      if (r.atPost >= 1) firstParked = { id, atPost: r.atPost, x: r.x };
    });
  };

  let plays = 0;
  const sequenceChecked = [];
  while (roomA.state.phase !== 'GAME_OVER') {
    await h.startPlay();
    plays += 1;
    const rollStart = h.rolls.length;
    const outcomesBefore = h.resolutions.length;
    // Hands off: no message of any kind until the play resolves itself.
    const playStart = Date.now();
    while (roomA.state.phase === 'PLAY') {
      pollRunners();
      if (Date.now() - playStart > 120000) throw new Error(`play ${plays} did not self-resolve in 120 s`);
      await sleep(10);
    }
    await waitFor(() => h.resolutions.length > outcomesBefore || roomA.state.phase === 'GAME_OVER' || h.rolls.length > rollStart, `play ${plays} broadcasts to settle`, 5000);
    await sleep(120); // let the roll backlog land before slicing
    sequenceChecked.push([h.rolls.slice(rollStart), `play ${plays}`]);
    if (plays > 120) throw new Error('game did not reach GAME_OVER within 120 plays');
  }
  log(`GAME_OVER after ${plays} plays | A ${roomA.state.scoreHalvesA}½ – B ${roomA.state.scoreHalvesB}½ | winner ${roomA.state.winner}`);

  check(plays >= 10, `a real game unfolded (${plays} plays ≥ 10)`);
  check(roomA.state.winner === 'A' || roomA.state.winner === 'B', `definite winner ('${roomA.state.winner}')`);
  const [hi, lo] = roomA.state.winner === 'A'
    ? [roomA.state.scoreHalvesA, roomA.state.scoreHalvesB]
    : [roomA.state.scoreHalvesB, roomA.state.scoreHalvesA];
  check(hi > lo, `winner strictly outscores the loser (${hi} > ${lo} half-rounders)`);
  check(h.resolutions.length >= plays - 1, `playOutcome broadcast per resolved play (${h.resolutions.length} for ${plays} plays)`);

  // ZERO play messages: structural (the loop above sends only confirm/ready) —
  // and the server agrees: no tombstone rejection ever came back to either side.
  const tombstoned = [...h.rejections.A, ...h.rejections.B].filter((r) => r.reason === TOMBSTONE);
  check(tombstoned.length === 0, `ZERO play messages sent by either client all game (no '${TOMBSTONE}' rejection ever received)`);
  check(h.rejections.A.length === 0 && h.rejections.B.length === 0, 'no rejection of ANY kind during the hands-off game');

  // Roll stream: per-play sequence sanity + gross volume.
  for (const [slice, label] of sequenceChecked) checkRollSequence(slice, label);
  const total = h.rolls.reduce((acc, r) => ((acc[r.contest] = (acc[r.contest] ?? 0) + 1), acc), {});
  check(h.rolls.length >= plays * 2, `roll broadcasts arrived for every beat (${h.rolls.length} total: ${JSON.stringify(total)})`);
  check((total.pitch ?? 0) >= plays && (total.swing ?? 0) >= plays, 'every play carried at least one pitch and one swing roll');
  check((total.run ?? 0) >= 1, 'runner-AI run rolls were broadcast');

  // Counter-clockwise orientation (schema-level).
  check(firstLeg !== null, 'the first runner was observed leaving the batting square');
  if (firstLeg !== null) {
    check(
      firstLeg.x < 0,
      `COUNTER-CLOCKWISE: the first runner (${firstLeg.id}) sets off into negative x — first ≥3 m sample at (${firstLeg.x.toFixed(2)}, ${firstLeg.z.toFixed(2)})`,
    );
    check(minX < -5, `COUNTER-CLOCKWISE: the first runner's opening run reached x = ${minX.toFixed(2)} < −5 (the post-1/post-2 region)`);
  }
  if (firstParked !== null) {
    log(`first parked arrival: ${firstParked.id} at post ${firstParked.atPost} (x = ${firstParked.x.toFixed(2)}) — logged, not orientation evidence`);
  }

  await h.roomA.leave(true);
  await sleep(300);
}

// ==================== ROOM 2: tombstones + pause freezes the dice ====================
log(`=== ROOM 2 (seed ${SEED + 1}): tombstone rejections + pause/reconnect ===`);
{
  const h = await openRoom('ATPP', { seed: SEED + 1 });
  await h.draft();
  const { roomA, roomB } = h;

  await h.startPlay();
  await waitFor(() => h.rolls.length >= 1, 'first roll of the play', 10000);

  // Tombstones, each from the role that USED to own the message (A bats, B fields).
  log('tombstone probe: fielding side B sends pitch');
  roomB.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
  let rej = await h.expectRejection('B', 'pitch', 'pitch rejection to B');
  check(rej.reason === TOMBSTONE, `pitch rejected with exactly '${TOMBSTONE}' (got '${rej.reason}')`);

  log('tombstone probe: batting side A sends swing');
  roomA.send('swing', { timing: 0, aim: { x: 0, y: 0, z: 1 }, spinInput: 0 });
  rej = await h.expectRejection('A', 'swing', 'swing rejection to A');
  check(rej.reason === TOMBSTONE, `swing rejected with exactly '${TOMBSTONE}' (got '${rej.reason}')`);

  log('tombstone probe: batting side A sends runDecision');
  roomA.send('runDecision', { go: true });
  rej = await h.expectRejection('A', 'runDecision', 'runDecision rejection to A');
  check(rej.reason === TOMBSTONE, `runDecision rejected with exactly '${TOMBSTONE}' (got '${rej.reason}')`);

  // The probes did not derail the auto-play: the beat machinery keeps rolling.
  const rollsAfterProbes = h.rolls.length;
  await waitFor(() => h.rolls.length > rollsAfterProbes || roomA.state.phase !== 'PLAY', 'beats continue after the probes', 30000);
  check(true, 'auto-play continued past the tombstone probes');

  // Pause mid-play: capture B's reconnection token, then drop the raw socket.
  // Make sure we are inside a PLAY with the dice running.
  while (roomA.state.phase !== 'PLAY') {
    if (roomA.state.phase === 'GAME_OVER') throw new Error('room 2 game ended before the pause probe');
    await h.startPlay();
  }
  const token = roomB.reconnectionToken;
  roomB.connection.transport.ws.close();
  log('B raw WebSocket closed (non-consented drop)');
  await waitFor(() => roomA.state.paused === true, 'paused = true synced to A', 5000);

  const rollsAtPause = h.rolls.length;
  const frozen1 = { x: roomA.state.ball.x, z: roomA.state.ball.z };
  log(`paused with ${rollsAtPause} rolls broadcast; ball at x=${frozen1.x.toFixed(4)} z=${frozen1.z.toFixed(4)}`);
  await sleep(1200);
  check(h.rolls.length === rollsAtPause, `NO roll broadcast across 1.2 s paused (still ${rollsAtPause})`);
  check(roomA.state.ball.x === frozen1.x && roomA.state.ball.z === frozen1.z, 'ball frozen while paused');
  check(roomA.state.paused === true, 'pause held');

  // Reconnect with the pre-drop token: the game unpauses and the dice resume.
  const clientB2 = new Client(URL);
  const roomB2 = await clientB2.reconnect(token);
  log(`B reconnected: sessionId=${roomB2.sessionId}`);
  roomB2.onMessage('playOutcome', () => {});
  roomB2.onMessage('rejected', () => {});
  roomB2.onMessage('roll', () => {});
  roomB2.onMessage('opponentLeft', () => {});
  await waitFor(() => roomA.state.paused === false, 'unpaused after reconnect', 5000);
  await waitFor(
    () => h.rolls.length > rollsAtPause || roomA.state.phase !== 'PLAY',
    'rolls resume after reconnect (or the thawed play resolves)',
    30000,
  );
  const resumedVia = h.rolls.length > rollsAtPause ? `roll #${h.rolls.length}` : `phase ${roomA.state.phase}`;
  check(true, `dice resumed after reconnect (${resumedVia})`);

  await roomA.leave(true);
  await sleep(300);
}

if (failures.length > 0) {
  log(`ACCEPTANCE FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
log('ACCEPTANCE PASSED (both rooms)');
process.exit(0);
