/**
 * Milestone 8 acceptance (spec §9.8): scripted colyseus.js clients against a
 * real Colyseus server (ws://localhost:2567, started with `npm run dev`).
 *
 * ROOM 1 (default 9 field slots — five-a-side squads, so benches are empty):
 *  1. Full table-order draft (A: carl,laurie,joel,jonty,joe; B: kian,josh,
 *     darcy,robbie,ricy; B fields innings 1, kian bowls).
 *  2. Reposition rejections, each with its exact reason: batting-side attempt
 *     → 'wrongRole'; pitcher → 'the pitcher moves via setPitcher'; out-of-zone
 *     (999,20) and batting-square keep-out (1,1) → the illegal-spot prose;
 *     during PLAY → the phase prose.
 *  3. B repositions josh to (5,20): the schema fielder moves, and the position
 *     survives confirm→ready into PLAY.
 *  4. Plays the game to the innings-2→3 switch and asserts B's CUSTOM layout
 *     (josh still at 5,20) plus the re-derived default pitcher (kian) return
 *     when B fields again.
 *
 * ROOM 2 (`fieldSlotsOverride: 3` — the test-only option, so a real bench):
 *  5. benchB = robbie,ricy; substitute josh→ricy (bench + subsUsed sync).
 *  6. setPitcher darcy, then a BENCHED nominee (josh) → 'benched — substitute
 *     them on before nominating'; then sub the bowler out (darcy→josh) → the
 *     pitcher re-derives to the on-field default (kian).
 *  7. Stamina ledger: a fielder drained by chasing in play 1 shows < stat in
 *     the next positioning phase (drain persisted); benched for play 2, they
 *     return with exactly min(stat, drained + BENCH_STAMINA_REGEN).
 *  8. setBatter: joe → currentBatterId flips and the displaced carl heads the
 *     queue; a fielding-side attempt draws 'wrongRole'. Sub cap (casual
 *     Infinity) is never hit — subsUsed just increments 1..4.
 *
 * A real verifier: failures accumulate and the process exits non-zero on any.
 * Log: m8-acceptance.txt (`.txt` because `*.log` is gitignored).
 */
import { Client } from 'colyseus.js';

const SEED = Number(process.argv[2] ?? 42);
const URL = 'ws://localhost:2567';
const POST_1 = { x: 11, z: 4 };
const BOWLER = { x: 0, z: 7.5 }; // PITCHING_SPOT = BOWLING_SQUARE
const MID_FIELD = { x: 0, z: 30 };

// Roster table order (shared/src/characters.ts) — first-remaining picks make the
// draft deterministic: A carl,laurie,joel,jonty,joe; B kian,josh,darcy,robbie,ricy.
const TABLE_IDS = ['carl', 'kian', 'laurie', 'josh', 'joel', 'darcy', 'jonty', 'robbie', 'joe', 'ricy', 'whale'];
const EXPECT_A = ['carl', 'laurie', 'joel', 'jonty', 'joe'];
const EXPECT_B = ['kian', 'josh', 'darcy', 'robbie', 'ricy'];
const DEFAULT_PITCHER = { A: 'joel', B: 'kian' };
// Stamina stats (shared/src/characters.ts) for ledger assertions.
const STAMINA_STAT = { carl: 7, kian: 6, laurie: 7, josh: 7, joel: 6, darcy: 7, jonty: 5, robbie: 6, joe: 3, ricy: 8 };
const BENCH_STAMINA_REGEN = 1;

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

  const h = { roomA, roomB, resolutions: [], rejections: { A: [], B: [] }, inningsSeen: 0 };
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
  roomA.onMessage('opponentLeft', () => {});
  roomB.onMessage('opponentLeft', () => {});

  let lastPhase = '';
  roomA.onStateChange((s) => {
    if (s.phase !== lastPhase) {
      log(`phase: ${lastPhase || '(joining)'} → ${s.phase} | A ${s.scoreHalvesA}½ – B ${s.scoreHalvesB}½ | innings ${s.inningsIndex + 1} | outs ${s.outs} | batting ${s.battingSide} | batter ${s.currentBatterId}`);
      lastPhase = s.phase;
    }
  });

  // ---- Play-driving helpers (the proven M7 loop) ----
  const batRoom = () => (roomA.state.battingSide === 'A' ? roomA : roomB);
  const fieldRoom = () => (roomA.state.battingSide === 'A' ? roomB : roomA);

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

  /** One pitch → swing attempt, each message from its role-correct client. */
  h.pitchSwing = async (target, aimY, decision) => {
    const bat = batRoom();
    const before = h.resolutions.length;
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
      if (h.resolutions.length > before) return true;
      if (roomA.state.phase !== 'PLAY') return true;
      if (!roomA.state.ballLive) {
        await sleep(200);
        if (h.resolutions.length > before || roomA.state.phase !== 'PLAY') return true;
        return false;
      }
      await sleep(30);
    }
    throw new Error('play neither resolved nor respawned in 12s');
  };

  h.play = async (style) => {
    await h.startPlay();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let done;
      if (style === 'loft') done = await h.pitchSwing(MID_FIELD, 1000, true);
      else if (style === 'loft-stop') done = await h.pitchSwing(MID_FIELD, 1000, false);
      else if (style === 'runout') done = await h.pitchSwing(POST_1, 0, true);
      else done = await h.pitchSwing(BOWLER, 0, false);
      if (done) {
        await waitFor(() => roomA.state.phase !== 'PLAY', 'play resolution to sync', 15000);
        return;
      }
      log('missed swing — re-pitching (quiet respawn path exercised)');
    }
    throw new Error('could not connect a swing in 8 pitches');
  };

  /** Clean table-order draft: whichever side is on turn picks the first remaining id. */
  h.draft = async () => {
    await waitFor(() => roomA.state.phase === 'DRAFT', 'room rests in DRAFT once both are seated');
    while (roomA.state.draftTurn !== '') {
      const turn = roomA.state.draftTurn;
      const picked = new Set([...roomA.state.squadAIds, ...roomA.state.squadBIds]);
      const id = TABLE_IDS.find((c) => !picked.has(c));
      const room = turn === 'A' ? roomA : roomB;
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

  /** Wait for the NEXT rejection to the given side and return it. */
  h.expectRejection = async (side, message, what) => {
    const list = h.rejections[side];
    const before = list.length;
    await waitFor(() => list.length > before && list[list.length - 1].message === message, what, 5000);
    return list[list.length - 1];
  };

  return h;
}

/** Assert the on-field set is exactly `side`'s squad slice with `pitcherId` pinned to the pitching spot. */
function checkFielding(h, side, expectedIds, pitcherId, label) {
  const keys = [...h.roomA.state.fielders.keys()].sort();
  const expected = [...expectedIds].sort();
  check(JSON.stringify(keys) === JSON.stringify(expected), `${label}: fielders are ${expected.join(',')} — got ${keys.join(',')}`);
  check(h.roomA.state.currentPitcherId === pitcherId, `${label}: currentPitcherId = ${pitcherId} (got '${h.roomA.state.currentPitcherId}')`);
  const bowler = h.roomA.state.fielders.get(pitcherId);
  check(
    bowler !== undefined && Math.abs(bowler.x - BOWLER.x) < 1e-6 && Math.abs(bowler.z - BOWLER.z) < 1e-6,
    `${label}: ${pitcherId} stands on the pitching spot (${BOWLER.x}, ${BOWLER.z})`,
  );
}

function fielderAt(h, id, x, z, label) {
  const f = h.roomA.state.fielders.get(id);
  check(
    f !== undefined && Math.abs(f.x - x) < 1e-6 && Math.abs(f.z - z) < 1e-6,
    `${label}: ${id} at (${x}, ${z}) — got (${f?.x}, ${f?.z})`,
  );
}

// ============================ ROOM 1: reposition + layout persistence ============================
log('=== ROOM 1 (9 field slots): reposition, rejections, layout persistence across innings ===');
{
  const h = await openRoom('MEVA', { seed: SEED });
  await h.draft();
  const { roomA, roomB } = h;

  check(roomA.state.benchA.length === 0 && roomA.state.benchB.length === 0, 'five-a-side squads with 9 slots: both benches empty');
  checkFielding(h, 'B', EXPECT_B, 'kian', 'innings 1 default');
  fielderAt(h, 'josh', 0, -3, 'default layout');

  // --- Rejections, each with its exact reason ---
  log("wrong-role demo: batting side A sends reposition {id:'josh', x:5, z:20}");
  roomA.send('reposition', { id: 'josh', x: 5, z: 20 });
  let rej = await h.expectRejection('A', 'reposition', 'reposition rejection to A');
  check(rej.reason === 'wrongRole', `batting-side reposition rejected with exactly 'wrongRole' (got '${rej.reason}')`);

  log("pitcher demo: fielding side B tries to reposition the bowler kian");
  roomB.send('reposition', { id: 'kian', x: 5, z: 20 });
  rej = await h.expectRejection('B', 'reposition', 'pitcher reposition rejection to B');
  check(rej.reason === 'the pitcher moves via setPitcher', `pitcher reposition rejected with the setPitcher prose (got '${rej.reason}')`);

  log('out-of-zone demo: B tries josh → (999, 20)');
  roomB.send('reposition', { id: 'josh', x: 999, z: 20 });
  rej = await h.expectRejection('B', 'reposition', 'out-of-zone rejection to B');
  check(rej.reason === 'illegal spot or not an on-field fielder', `out-of-zone rejected with the illegal-spot prose (got '${rej.reason}')`);

  log('keep-out demo: B tries josh → (1, 1), 1.41 m from the batting square');
  roomB.send('reposition', { id: 'josh', x: 1, z: 1 });
  rej = await h.expectRejection('B', 'reposition', 'keep-out rejection to B');
  check(rej.reason === 'illegal spot or not an on-field fielder', `keep-out rejected with the illegal-spot prose (got '${rej.reason}')`);
  fielderAt(h, 'josh', 0, -3, 'after the four rejections');

  // --- The real reposition: schema fielder moves and survives into PLAY ---
  log('fielding side B repositions josh → (5, 20)');
  roomB.send('reposition', { id: 'josh', x: 5, z: 20 });
  await waitFor(() => Math.abs(roomA.state.fielders.get('josh')?.x - 5) < 1e-6, 'josh schema position synced', 5000);
  fielderAt(h, 'josh', 5, 20, 'after reposition');

  roomA.send('confirmPositioning');
  roomB.send('confirmPositioning');
  await waitFor(() => roomA.state.phase === 'PRE_PLAY', 'PRE_PLAY', 5000);
  roomA.send('readyForPlay');
  roomB.send('readyForPlay');
  await waitFor(() => roomA.state.phase === 'PLAY', 'PLAY', 5000);
  fielderAt(h, 'josh', 5, 20, 'custom position survives into PLAY');

  log('phase-lock demo: B tries a reposition during PLAY');
  roomB.send('reposition', { id: 'josh', x: 6, z: 20 });
  rej = await h.expectRejection('B', 'reposition', 'PLAY-phase reposition rejection to B');
  check(
    rej.reason === 'only allowed in INITIAL_POSITIONING or PRE_PLAY (phase PLAY)',
    `PLAY-locked reposition rejected with the phase prose (got '${rej.reason}')`,
  );
  fielderAt(h, 'josh', 5, 20, 'unchanged by the PLAY-phase attempt');

  // --- Drive the game across two innings switches: the custom layout must return ---
  log('=== driving innings to the switches (M7 loop) ===');
  let plays = 0;
  // NOTE: no second onMessage('playOutcome') here — colyseus.js keeps ONE handler
  // per message type, so re-registering would clobber the harness's resolution log.
  const runOuts = () => h.resolutions.filter((r) => r.cause.kind === 'runOut').length;
  while (roomA.state.inningsIndex < 2 && roomA.state.phase !== 'GAME_OVER' && plays < 140) {
    const battingA = roomA.state.battingSide === 'A';
    const style = battingA ? 'loft' : runOuts() === 0 ? 'runout' : 'stop';
    await h.play(style);
    plays += 1;
    if (roomA.state.inningsIndex === 1 && h.inningsSeen === 0) {
      h.inningsSeen = 1;
      checkFielding(h, 'A', EXPECT_A, DEFAULT_PITCHER.A, 'innings 2 switch (A fields)');
    }
  }
  log(`plays driven: ${plays}`);
  check(roomA.state.inningsIndex === 2, `reached innings 3 (B fields again) — inningsIndex ${roomA.state.inningsIndex}`);
  checkFielding(h, 'B', EXPECT_B, 'kian', 'innings 3 switch (B fields again, default pitcher re-derived)');
  fielderAt(h, 'josh', 5, 20, "B's CUSTOM layout returned when B fields again");

  await roomB.leave(true);
  await sleep(500);
}

// ============================ ROOM 2: fieldSlotsOverride 3 — bench, subs, ledger, setBatter ============================
log('=== ROOM 2 (fieldSlotsOverride: 3): bench, substitutions, pitcher re-derivation, stamina ledger, setBatter ===');
{
  const h = await openRoom('MEVB', { seed: SEED + 1, fieldSlotsOverride: 3 });
  await h.draft();
  const { roomA, roomB } = h;

  check(JSON.stringify([...roomA.state.benchB]) === JSON.stringify(['robbie', 'ricy']), `benchB = robbie,ricy (got ${[...roomA.state.benchB].join(',')})`);
  check(JSON.stringify([...roomA.state.benchA]) === JSON.stringify(['jonty', 'joe']), `benchA = jonty,joe (got ${[...roomA.state.benchA].join(',')})`);
  check(roomA.state.subsUsedB === 0, 'subsUsedB starts at 0');
  checkFielding(h, 'B', ['kian', 'josh', 'darcy'], 'kian', '3-slot innings 1 default');

  // --- setBatter (batting side A) ---
  check(roomA.state.currentBatterId === 'carl', `first batter is carl (got '${roomA.state.currentBatterId}')`);
  check(JSON.stringify([...roomA.state.queueIds]) === JSON.stringify(['laurie', 'joel', 'jonty', 'joe']), `queue = laurie,joel,jonty,joe (got ${[...roomA.state.queueIds].join(',')})`);
  log("fielding side B tries setBatter {id:'joe'} (wrong role)");
  roomB.send('setBatter', { id: 'joe' });
  let rej = await h.expectRejection('B', 'setBatter', 'setBatter rejection to B');
  check(rej.reason === 'wrongRole', `fielding-side setBatter rejected with exactly 'wrongRole' (got '${rej.reason}')`);
  log("batting side A sends setBatter {id:'joe'}");
  roomA.send('setBatter', { id: 'joe' });
  await waitFor(() => roomA.state.currentBatterId === 'joe', 'setBatter synced', 5000);
  check(roomA.state.queueIds[0] === 'carl', `displaced carl heads the queue (got '${roomA.state.queueIds[0]}')`);
  log("restoring carl via a second setBatter (also proves re-selection)");
  roomA.send('setBatter', { id: 'carl' });
  await waitFor(() => roomA.state.currentBatterId === 'carl', 'batter restored to carl', 5000);
  check(roomA.state.queueIds[0] === 'joe', `displaced joe heads the queue (got '${roomA.state.queueIds[0]}')`);

  // --- Substitution: josh → ricy (bench + count sync) ---
  log("fielding side B sends substitute {outId:'josh', inId:'ricy'}");
  roomB.send('substitute', { outId: 'josh', inId: 'ricy' });
  await waitFor(() => roomA.state.subsUsedB === 1, 'substitution synced', 5000);
  check(JSON.stringify([...roomA.state.benchB]) === JSON.stringify(['robbie', 'josh']), `benchB = robbie,josh after the sub (got ${[...roomA.state.benchB].join(',')})`);
  checkFielding(h, 'B', ['kian', 'darcy', 'ricy'], 'kian', 'after josh→ricy');
  fielderAt(h, 'ricy', 0, -3, "ricy inherits josh's position");

  // --- Pitcher nomination + benched-nominee rejection + subbed-out re-derivation ---
  log("B nominates darcy as bowler, then tries the BENCHED josh");
  roomB.send('setPitcher', { id: 'darcy' });
  await waitFor(() => roomA.state.currentPitcherId === 'darcy', 'darcy nominated', 5000);
  fielderAt(h, 'darcy', 0, 7.5, 'nominated darcy pinned to the pitching spot');
  roomB.send('setPitcher', { id: 'josh' });
  rej = await h.expectRejection('B', 'setPitcher', 'benched-nominee rejection to B');
  check(rej.reason === 'benched — substitute them on before nominating', `benched setPitcher nominee rejected with the bench prose (got '${rej.reason}')`);
  check(roomA.state.currentPitcherId === 'darcy', 'pitcher unchanged by the benched nomination');
  log("B subs the BOWLER out (darcy→josh): the pitcher must re-derive to the on-field default");
  roomB.send('substitute', { outId: 'darcy', inId: 'josh' });
  await waitFor(() => roomA.state.subsUsedB === 2, 'bowler substitution synced', 5000);
  check(roomA.state.currentPitcherId === 'kian', `pitcher re-derived to on-field default kian (got '${roomA.state.currentPitcherId}')`);
  check(JSON.stringify([...roomA.state.benchB]) === JSON.stringify(['robbie', 'darcy']), `benchB = robbie,darcy (got ${[...roomA.state.benchB].join(',')})`);

  // --- Stamina ledger: drain in play 1, bench regen across play 2 ---
  log('repositioning ricy → (2, 22) as chase bait for the lofted hit');
  roomB.send('reposition', { id: 'ricy', x: 2, z: 22 });
  await waitFor(() => Math.abs(roomA.state.fielders.get('ricy')?.z - 22) < 1e-6, 'ricy reposition synced', 5000);

  log('play 1: lofted hit into the deep field (runner told to stop) — a fielder must sprint and drain');
  await h.play('loft-stop');
  await waitFor(() => roomA.state.phase === 'PRE_PLAY', 'next positioning phase', 10000);

  const drained = [];
  roomA.state.fielders.forEach((f, id) => {
    const stat = STAMINA_STAT[id];
    if (f.stamina < stat - 0.01) drained.push({ id, stamina: f.stamina, stat });
    log(`  fielder ${id}: stamina ${f.stamina.toFixed(3)} / stat ${stat}`);
  });
  check(drained.length > 0, 'some on-field fielder is below stat next play (cross-play drain persisted)');
  const d = drained.find((f) => f.id !== roomA.state.currentPitcherId);
  check(d !== undefined, `a NON-pitcher fielder drained (got: ${drained.map((f) => f.id).join(',') || 'none'})`);

  if (d !== undefined) {
    const replacement = roomA.state.benchB[0];
    log(`benching the drained ${d.id} (stamina ${d.stamina.toFixed(3)}) for ${replacement}; they sit out play 2`);
    roomB.send('substitute', { outId: d.id, inId: replacement });
    await waitFor(() => roomA.state.subsUsedB === 3, 'drained fielder benched', 5000);

    log('play 2: any resolved play (the benched fielder regains BENCH_STAMINA_REGEN at its end)');
    await h.play('loft-stop');
    await waitFor(() => roomA.state.phase === 'PRE_PLAY' || roomA.state.phase === 'GAME_OVER', 'play 2 resolved', 10000);

    log(`bringing ${d.id} back on for ${replacement}`);
    roomB.send('substitute', { outId: replacement, inId: d.id });
    await waitFor(() => roomA.state.subsUsedB === 4, 'drained fielder back on', 5000);
    const after = roomA.state.fielders.get(d.id);
    const expected = Math.min(d.stat, d.stamina + BENCH_STAMINA_REGEN);
    check(
      after !== undefined && Math.abs(after.stamina - expected) < 1e-6,
      `${d.id} regained bench stamina while sitting out: ${after?.stamina.toFixed(3)} = min(stat ${d.stat}, ${d.stamina.toFixed(3)} + ${BENCH_STAMINA_REGEN})`,
    );
    check(after !== undefined && after.stamina > d.stamina, `${d.id} came back with MORE stamina than they left with`);
  }

  check(roomA.state.subsUsedB === 4, `sub count incremented freely to 4 (casual cap is Infinity, never hit) — got ${roomA.state.subsUsedB}`);

  await roomB.leave(true);
  await sleep(500);
}

if (failures.length > 0) {
  log(`ACCEPTANCE FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
log('ACCEPTANCE PASSED');
process.exit(0);
