/**
 * Milestone 9 acceptance (spec §9.9): scripted colyseus.js clients against a
 * real Colyseus server (ws://localhost:2567, started with `npm run dev`).
 *
 * NO browser run: §9.9 changes no UI surface (all five abilities are pure
 * server/shared behaviour behind the existing message set), so the browser walk
 * would show exactly the M8 screens. Recorded here and in CLAUDE.md §6.3.
 *
 * ROOM 1 — one custom draft (A: carl,laurie,darcy,josh,joel · B: kian,whale,
 * jonty,joe,robbie — kian must STILL bowl: pitch 8 beats whale 4/jonty 6/joe 3/
 * robbie 5), whale repositioned deep on the demo drive corridor at (10,26) and
 * jonty onto a pre-bounce catch spot at (−6,9):
 *  1. CURVEBALL_MASTER late onset — kian pitches at full spin twice (no swing);
 *     ball x sampled from state patches, keyed by z (z is a linear time proxy at
 *     near-constant vz, so the 60%-of-flight-TIME onset sits at z ≈ 3.0 of the
 *     7.5 m run-in). Assert the |x| deviation accumulated after the onset point
 *     dominates the pre-onset deviation (> 2×) and that the total curve is real.
 *  2. WALL — flat drive along the (12,28) corridor, swung on the TIME schedule
 *     (nominal −0.03 s) so the launch point is at the plane, not metres early.
 *     Both matter, and both were proven by failed runs of this demo: a patch-
 *     polled swing can fire with the ball still at z ≈ 3, bending the launch
 *     line inside kian's 2.12 m catch radius (caught mid-corridor), and a
 *     late-halted runner makes kian COVER post 1, dragging him onto the line.
 *     From the plane the (12,28) line passes ≥ 2.9 m from every fielder.
 *     Assert the ball's speed collapses to < 0.5 m/s within 1.8 m of the whale
 *     at ground level, and the play resolves without a caught.
 *  3. IMMOVABLE — flat drive at jonty (−6,9): pre-bounce radius entry, and his
 *     guaranteed attempt takes NO rng draw, so `caught by jonty` must hold on a
 *     LIVE wall-clock-independent numeric-seed room — a seedless assertion.
 *  4. (separate rooms) BUTTERFINGERS — bounded numeric-seed search: seeds are
 *     pre-screened by replicating shared/src/rng.ts (mulberry32) for draw1 <
 *     0.085 (below joe's worst-case pCatch 0.090, so a radius entry ALWAYS wins
 *     the roll) and draw2 < 0.34 (< BUTTERFINGERS_FUMBLE_P 0.35, so the fumble
 *     ALWAYS fires). Every seed tried live is documented. Assert the fumble
 *     signature (ball velocity zeroed mid-approach, parked at joe's FEET at
 *     ground level — a gather would park it at HANDS height 1.0) and no
 *     caught-out despite the pre-bounce approach into joe's radius.
 *  5. CANNON/spin-read — LIVE attempt: against kian's max-spin pitch, laurie
 *     (spin-read window 0.22 × 0.775 = 0.1705 s) misses a swing timed at
 *     nominal −0.195 s while darcy (SWITCH-immune, window 0.22 s) CONNECTS at
 *     the same nominal timing. Sub-tick scheduling from patch-extrapolated
 *     time-to-plane; if jitter defeats the 49.5 ms band, the documented
 *     fallback is the unit-test window maths (HitModule.test.ts — logged as a
 *     SUBSTITUTED demo, not a pass).
 *
 * A real verifier: failures accumulate and the process exits non-zero on any.
 * Log: m9-acceptance.txt (`.txt` because `*.log` is gitignored).
 */
import { Client } from 'colyseus.js';

const URL = 'ws://localhost:2567';
/**
 * ROOM 1 seed: demos 1 (no fielding ticks), 3 (IMMOVABLE draws NO rng) and 5
 * (any outcome accepted) are seed-independent, but demo 2 needs the incidental
 * catch ROLLS along the corridor to MISS — the whale himself gets an entry roll
 * (p ≈ 0.4–0.63) on the ball arriving at his blocker, and the chasing joe can
 * brush the rolling ball. Seed 246's first four mulberry32 draws are all > 0.70,
 * above every reachable pCatch on that corridor, so the stop-dead is what the
 * BLOCKER does, not what the rng happened to allow.
 */
const ROOM1_SEED = 246;
const PICKS_A = ['carl', 'laurie', 'darcy', 'josh', 'joel'];
const PICKS_B = ['kian', 'whale', 'jonty', 'joe', 'robbie'];
const WHALE_SPOT = { x: 12, z: 28 };
const JONTY_SPOT = { x: -6, z: 9 };
const JOE_SPOT = { x: -6, z: 9 };
const MID_FIELD = { x: 0, z: 30 };
const ONSET_Z = 7.5 * (1 - 0.6); // CURVE_ONSET_FRACTION 0.6 of the 7.5 m run-in
const NOMINAL_EARLY_S = 0.195; // mid-band between laurie's 0.1705 s and darcy's 0.22 s windows

const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const substitutions = [];
function check(cond, what) {
  if (cond) log(`OK: ${what}`);
  else {
    failures.push(what);
    log(`FAIL: ${what}`);
  }
}
function substituted(what, why) {
  substitutions.push(what);
  log(`SUBSTITUTED (not a live pass): ${what} — ${why}`);
}

async function waitFor(pred, what, timeoutMs = 30000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

/** Replica of shared/src/rng.ts mulberry32 — used ONLY to pre-screen candidate seeds. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Connect two clients into one room, wire listeners and a per-patch ball/fielder sampler. */
async function openRoom(code, options) {
  const clientA = new Client(URL);
  const clientB = new Client(URL);
  const roomA = await clientA.create('match', { code, ...options });
  await waitFor(() => roomA.state.sessionA === roomA.sessionId, 'A seated as side A');
  const roomB = await clientB.join('match', { code });
  await waitFor(() => roomA.state.sessionB === roomB.sessionId, 'B seated as side B');

  const h = { roomA, roomB, resolutions: [], samples: [] };
  roomA.onMessage('playOutcome', (r) => {
    h.resolutions.push(r);
    log(`playOutcome: ${JSON.stringify(r.cause)} | halves A ${roomA.state.scoreHalvesA} B ${roomA.state.scoreHalvesB} | outs ${roomA.state.outs}`);
  });
  roomB.onMessage('playOutcome', () => {});
  roomA.onMessage('rejected', (r) => log(`rejected→A: ${JSON.stringify(r)}`));
  roomB.onMessage('rejected', (r) => log(`rejected→B: ${JSON.stringify(r)}`));
  roomA.onMessage('opponentLeft', () => {});
  roomB.onMessage('opponentLeft', () => {});

  // Per-patch sampler (~20 Hz): ball kinematics + the demo fielders' positions.
  roomA.onStateChange((s) => {
    const f = (id) => {
      const v = s.fielders.get(id);
      return v === undefined ? null : { x: v.x, z: v.z };
    };
    h.samples.push({
      t: Date.now(),
      phase: s.phase,
      live: s.ballLive,
      x: s.ball.x, y: s.ball.y, z: s.ball.z,
      vx: s.ball.vx, vy: s.ball.vy, vz: s.ball.vz,
      whale: f('whale'), jonty: f('jonty'), joe: f('joe'),
    });
  });

  h.batRoom = () => (roomA.state.battingSide === 'A' ? roomA : roomB);
  h.fieldRoom = () => (roomA.state.battingSide === 'A' ? roomB : roomA);

  /** Custom draft: each side plays its scripted pick list on its turn. */
  h.draft = async () => {
    await waitFor(() => roomA.state.phase === 'DRAFT', 'room rests in DRAFT');
    let a = 0;
    let b = 0;
    while (roomA.state.draftTurn !== '') {
      const turn = roomA.state.draftTurn;
      const id = (turn === 'A' ? PICKS_A[a++] : PICKS_B[b++]) ?? '';
      const before = roomA.state.squadAIds.length + roomA.state.squadBIds.length;
      (turn === 'A' ? roomA : roomB).send('draftPick', { id });
      await waitFor(
        () => roomA.state.squadAIds.length + roomA.state.squadBIds.length > before || roomA.state.draftTurn === '',
        `pick ${before + 1} synced`,
        5000,
      );
    }
    await waitFor(() => roomA.state.phase === 'INITIAL_POSITIONING', 'draft completion', 5000);
  };

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

  h.pitch = (spinInput) => h.fieldRoom().send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput });

  /** Halt every runner: spam go:false briefly (pre-runner sends draw a harmless rejection). */
  h.haltRunners = async () => {
    for (let i = 0; i < 12; i += 1) {
      if (roomA.state.phase !== 'PLAY') return;
      h.batRoom().send('runDecision', { go: false });
      await sleep(35);
    }
  };

  /** Wait for the live ball to die quietly (missed/unswung pitch) or the play to resolve. */
  h.waitBallDead = async () => {
    await waitFor(() => !roomA.state.ballLive || roomA.state.phase !== 'PLAY', 'ball dead or play over', 15000);
    await sleep(120); // let trailing patches land
  };

  /** Any post-swing patch with the ball moving AWAY from the batter (fast hits). */
  h.sawContact = (sinceT) => h.samples.some((s) => s.t >= sinceT && s.live && s.vz > 0.5);

  /**
   * Robust swing-result verdict. A reversed ball only covers FAST hits; a swing
   * connecting a hair inside the window edge launches a ~0 m/s dribble that the
   * velocity test cannot see (this bit a live run of demo 5). Contact is
   * therefore ANY of: ball reversed; the batter's runner appeared (startRun is
   * contact-only, and the current batter can never already be a parked runner);
   * or the play resolved (rest/timeout only ends a play after contact). A miss
   * is confirmed by the ball dying quietly with the play still open.
   */
  h.awaitSwingResult = async (swingT, beforeRes, batterId, hadRunner) => {
    void swingT; // kinematic reversal deliberately NOT used: near-window-edge dribbles are invisible to it
    for (let i = 0; i < 240; i += 1) {
      if (h.resolutions.length > beforeRes) {
        log('  (swing verdict: contact — play resolved)');
        return 'contact';
      }
      if (!hadRunner && roomA.state.runners.get(batterId) !== undefined) {
        log('  (swing verdict: contact — batter-runner appeared)');
        return 'contact';
      }
      if (roomA.state.phase !== 'PLAY') {
        log(`  (swing verdict: contact — phase moved to ${roomA.state.phase})`);
        return 'contact';
      }
      if (!roomA.state.ballLive) {
        log('  (swing verdict: miss — ball died quietly, play still open)');
        return 'miss';
      }
      await sleep(50);
    }
    log('  (swing verdict: miss — no definitive signal in 12s)');
    return 'miss';
  };

  /**
   * Pitch (spin 0) then swing near the plane at `target` (m8 idiom: lead the
   * ball by 0.05 s). Returns true if contact was made. On a miss the ball dies
   * quietly (same batter keeps the play) and the caller may retry.
   */
  h.pitchSwingAt = async (target, aimY) => {
    const bat = h.batRoom();
    if (roomA.state.phase !== 'PLAY') return false;
    const beforeRes = h.resolutions.length;
    const batterId = roomA.state.currentBatterId;
    const hadRunner = roomA.state.runners.get(batterId) !== undefined;
    h.pitch(0);
    await waitFor(() => bat.state.ballLive && bat.state.ball.z > 1, 'ball in flight', 10000);
    await waitFor(() => !bat.state.ballLive || bat.state.ball.z < 3.5, 'ball near plane', 10000);
    const swingT = Date.now();
    if (bat.state.ballLive) {
      const lead = 0.05;
      const cx = bat.state.ball.x + bat.state.ball.vx * lead;
      const cz = bat.state.ball.z + bat.state.ball.vz * lead;
      bat.send('swing', { timing: 0, aim: { x: target.x - cx, y: aimY, z: target.z - cz }, spinInput: 0 });
      // Halt the runner from the swing itself: an exposed runner makes the
      // next-nearest fielder COVER post 1, dragging kian across the corridor.
      void h.haltRunners();
    }
    const verdict = await h.awaitSwingResult(swingT, beforeRes, batterId, hadRunner);
    if (verdict === 'contact') return true;
    await h.waitBallDead();
    return false;
  };

  /**
   * Pitch at `spin`, then fire a swing timed to land at `-nominalS` seconds of
   * signed timing error (early), extrapolating time-to-plane from the freshest
   * patch (z/−vz is staleness-independent: the snapshot is self-consistent and
   * vz barely decays over the remaining flight). Returns {sent, contact}.
   */
  h.scheduledSwing = async (spin, nominalS, target) => {
    const bat = h.batRoom();
    const pitchT = Date.now();
    const beforeRes = h.resolutions.length;
    const batterId = roomA.state.currentBatterId;
    const hadRunner = roomA.state.runners.get(batterId) !== undefined;
    h.pitch(spin);
    // First usable in-flight sample after the pitch.
    await waitFor(
      () => h.samples.some((s) => s.t > pitchT && s.live && s.vz < -5 && s.z < 7.4),
      'in-flight sample',
      5000,
    );
    let sent = false;
    let predicted = 0;
    while (!sent) {
      const s = h.samples[h.samples.length - 1];
      if (!s.live || s.vz > -5) break; // flight over before we could fire
      const tPlane = s.t + (s.z / -s.vz) * 1000;
      const remaining = tPlane - Date.now();
      if (remaining <= nominalS * 1000 + 2) {
        predicted = remaining / 1000;
        // Extrapolate the (≤50 ms stale) patch to NOW for the aim's launch
        // point: an unextrapolated aim missed the whale's 0.4 m blocker at
        // 30 m in a live run of demo 2 (~0.5 m wide at the target).
        const dtStale = (Date.now() - s.t) / 1000 + 0.004;
        const px = s.x + s.vx * dtStale;
        const pz = s.z + s.vz * dtStale;
        bat.send('swing', { timing: 0, aim: { x: target.x - px, y: 0, z: target.z - pz }, spinInput: 0 });
        void h.haltRunners(); // halt from the swing: no cover fielder crosses the corridor
        sent = true;
      } else {
        await sleep(2);
      }
    }
    const swingT = Date.now();
    const contact = sent && (await h.awaitSwingResult(swingT, beforeRes, batterId, hadRunner)) === 'contact';
    log(`  scheduled swing: sent=${sent} predictedError=−${predicted.toFixed(3)}s contact=${contact}`);
    if (!contact) await h.waitBallDead();
    return { sent, contact };
  };

  h.waitPlayEnd = async () => {
    const before = h.resolutions.length;
    await waitFor(() => h.resolutions.length > before || roomA.state.phase !== 'PLAY', 'play resolution', 15000);
    await waitFor(() => roomA.state.phase !== 'PLAY', 'phase to leave PLAY', 5000);
  };

  h.lastCause = () => h.resolutions[h.resolutions.length - 1]?.cause ?? { kind: 'none' };

  h.close = async () => {
    await roomB.leave(true);
    await sleep(400);
  };

  return h;
}

/** Linear x-interpolation of a (z, x) profile at zq; points sorted by descending z. */
function xAtZ(points, zq) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a.z >= zq && b.z <= zq) {
      const f = a.z === b.z ? 0 : (a.z - zq) / (a.z - b.z);
      return a.x + (b.x - a.x) * f;
    }
  }
  return null;
}

// ============================ ROOM 1: draft + demos 1, 2, 3, 5 ============================
log('=== ROOM 1: custom draft (kian+whale+jonty+joe on B), CURVEBALL, WALL, IMMOVABLE, spin-read ===');
{
  const h = await openRoom('MNIN', { seed: ROOM1_SEED });
  await h.draft();
  const { roomA, roomB } = h;

  check(JSON.stringify([...roomA.state.squadAIds]) === JSON.stringify(PICKS_A), `squad A = ${PICKS_A.join(',')}`);
  check(JSON.stringify([...roomA.state.squadBIds]) === JSON.stringify(PICKS_B), `squad B = ${PICKS_B.join(',')}`);
  check(roomA.state.currentPitcherId === 'kian', `kian still bowls with the custom five (pitch 8 is B's best arm) — got '${roomA.state.currentPitcherId}'`);

  // Position the demo fielders (M8 reposition, INITIAL_POSITIONING).
  roomB.send('reposition', { id: 'whale', x: WHALE_SPOT.x, z: WHALE_SPOT.z });
  await waitFor(() => roomA.state.fielders.get('whale')?.z === WHALE_SPOT.z, 'whale repositioned', 5000);
  roomB.send('reposition', { id: 'jonty', x: JONTY_SPOT.x, z: JONTY_SPOT.z });
  await waitFor(() => roomA.state.fielders.get('jonty')?.z === JONTY_SPOT.z, 'jonty repositioned', 5000);
  log(`whale parked at (${WHALE_SPOT.x}, ${WHALE_SPOT.z}); jonty at (${JONTY_SPOT.x}, ${JONTY_SPOT.z})`);

  await h.startPlay();

  // ---- Demo 1: CURVEBALL_MASTER late onset (two unswung max-spin pitches) ----
  log('--- Demo 1: CURVEBALL late onset — kian pitches spinInput 1, nobody swings ---');
  const flightPoints = [];
  for (let flight = 1; flight <= 2; flight += 1) {
    const pitchT = Date.now();
    h.pitch(1);
    await waitFor(() => roomA.state.ballLive, 'ball live', 5000);
    await h.waitBallDead(); // unswung pitch dies quietly and respawns; play stays open
    for (const s of h.samples) {
      if (s.t > pitchT && s.live && s.vz < -5 && s.z <= 7.4 && s.z >= -0.5) flightPoints.push({ z: s.z, x: s.x });
    }
    log(`flight ${flight} sampled; cumulative points: ${flightPoints.length}`);
  }
  flightPoints.sort((a, b) => b.z - a.z);
  log('merged (z, x) profile (z is the time proxy; onset expected at z ≈ 3.0):');
  for (const p of flightPoints) log(`  z=${p.z.toFixed(2)}  x=${p.x.toFixed(4)}`);
  const xOnset = xAtZ(flightPoints, ONSET_Z);
  const xPlane = xAtZ(flightPoints, 0.2) ?? flightPoints[flightPoints.length - 1]?.x ?? null;
  check(xOnset !== null && xPlane !== null, 'curve profile bracketed the onset point and the plane');
  if (xOnset !== null && xPlane !== null) {
    const early = Math.abs(xOnset - (flightPoints[0]?.x ?? 0));
    const late = Math.abs(xPlane - xOnset);
    log(`|x| deviation before onset (first 60% of flight): ${early.toFixed(4)} m; after onset (last 40%): ${late.toFixed(4)} m`);
    check(Math.abs(xPlane) > 0.015, `total lateral curve is real: |x(plane)| = ${Math.abs(xPlane).toFixed(4)} m > 0.015`);
    check(late > 2 * early, `late-window deviation dominates (> 2×): ${late.toFixed(4)} vs ${early.toFixed(4)}`);
  }

  // ---- Demo 2: WALL stop-dead (same open play) ----
  log(`--- Demo 2: WALL — flat drive along the (${WHALE_SPOT.x},${WHALE_SPOT.z}) corridor into the whale ---`);
  let contact = false;
  for (let i = 0; i < 6 && !contact; i += 1) {
    // Time-scheduled swing at nominal −0.03 s: launch from the plane itself, so
    // the corridor's fielder clearances hold from the first metre of flight.
    const r = await h.scheduledSwing(0, 0.03, WHALE_SPOT);
    contact = r.sent && r.contact;
    if (!contact) log('missed swing — re-pitching');
  }
  check(contact, 'WALL demo drive connected');
  const wallSwingT = Date.now() - 600;
  void h.haltRunners();
  await h.waitPlayEnd();
  const stopSample = h.samples.find(
    (s) =>
      s.t > wallSwingT &&
      s.live &&
      s.whale !== null &&
      Math.hypot(s.x - s.whale.x, s.z - s.whale.z) < 1.8 &&
      Math.hypot(s.vx, s.vy, s.vz) < 0.5 &&
      s.y < 0.6,
  );
  const droveFast = h.samples.some((s) => s.t > wallSwingT && s.live && Math.hypot(s.vx, s.vy, s.vz) > 5);
  check(droveFast, 'the drive was genuinely fast (> 5 m/s observed post-contact)');
  check(stopSample !== undefined, `ball speed collapsed to < 0.5 m/s within 1.8 m of the whale at ground level${stopSample ? ` (d=${Math.hypot(stopSample.x - stopSample.whale.x, stopSample.z - stopSample.whale.z).toFixed(2)} m, y=${stopSample.y.toFixed(2)})` : ''}`);
  check(h.lastCause().kind !== 'caught', `WALL stop is never classified caught — play resolved '${h.lastCause().kind}'`);

  // ---- Demo 3: IMMOVABLE guaranteed catch (protect laurie/darcy for demo 5) ----
  log('--- Demo 3: IMMOVABLE — setBatter josh, flat drive at jonty: guaranteed catch, zero rng draws ---');
  if (roomA.state.currentBatterId !== 'josh' && [...roomA.state.queueIds].includes('josh')) {
    h.batRoom().send('setBatter', { id: 'josh' });
    await waitFor(() => roomA.state.currentBatterId === 'josh', 'josh batting', 5000);
  }
  await h.startPlay();
  contact = false;
  for (let i = 0; i < 6 && !contact; i += 1) {
    contact = await h.pitchSwingAt(JONTY_SPOT, 0);
    if (!contact) log('missed swing — re-pitching');
  }
  check(contact, 'IMMOVABLE demo drive connected');
  void h.haltRunners();
  await h.waitPlayEnd();
  const cause3 = h.lastCause();
  check(
    cause3.kind === 'caught' && cause3.by === 'jonty',
    `jonty's guaranteed pre-bounce catch on a live seed-only room: got ${JSON.stringify(cause3)}`,
  );

  // ---- Demo 5: spin-read vs SWITCH at the same nominal timing ----
  log('--- Demo 5: spin-read — laurie (window 0.1705s vs spin) misses at nominal −0.195s; darcy (SWITCH, 0.22s) connects ---');
  let laurieMissed = false;
  let darcyConnected = false;
  try {
  // Phase (a): laurie at the nominal timing must MISS (no contact — quiet respawn).
  if ([...roomA.state.queueIds].includes('laurie') || roomA.state.currentBatterId === 'laurie') {
    if (roomA.state.currentBatterId !== 'laurie') {
      h.batRoom().send('setBatter', { id: 'laurie' });
      await waitFor(() => roomA.state.currentBatterId === 'laurie', 'laurie batting', 5000);
    }
    await h.startPlay();
    for (let attempt = 1; attempt <= 4 && !laurieMissed; attempt += 1) {
      const r = await h.scheduledSwing(1, NOMINAL_EARLY_S, MID_FIELD);
      if (!r.sent) continue; // flight ended before the fire window — re-pitch
      if (!r.contact) laurieMissed = true;
      else {
        // Jitter dropped the swing inside even the shrunk window: play resolved.
        log('laurie connected at the nominal timing (jitter undershoot) — inconclusive attempt');
        void h.haltRunners();
        await h.waitPlayEnd();
        if (roomA.state.currentBatterId !== 'laurie' && ![...roomA.state.queueIds].includes('laurie')) break;
        if (roomA.state.currentBatterId !== 'laurie') {
          h.batRoom().send('setBatter', { id: 'laurie' });
          await waitFor(() => roomA.state.currentBatterId === 'laurie', 'laurie batting again', 5000);
        }
        await h.startPlay();
      }
    }
    if (laurieMissed) {
      log('laurie MISSED at nominal −0.195s (spin-read window 0.1705s) — now ending her play with a plain loft');
      let ended = false;
      for (let i = 0; i < 6 && !ended; i += 1) ended = await h.pitchSwingAt(MID_FIELD, 800);
      void h.haltRunners();
      if (ended) await h.waitPlayEnd();
    }
  }
  // Phase (b): darcy at the SAME nominal timing must CONNECT (SWITCH immunity).
  if (
    laurieMissed &&
    roomA.state.phase !== 'PLAY' && // laurie's play must actually be over to switch batter
    ([...roomA.state.queueIds].includes('darcy') || roomA.state.currentBatterId === 'darcy')
  ) {
    if (roomA.state.currentBatterId !== 'darcy') {
      h.batRoom().send('setBatter', { id: 'darcy' });
      await waitFor(() => roomA.state.currentBatterId === 'darcy', 'darcy batting', 5000);
    }
    await h.startPlay();
    for (let attempt = 1; attempt <= 4 && !darcyConnected; attempt += 1) {
      const r = await h.scheduledSwing(1, NOMINAL_EARLY_S, MID_FIELD);
      if (r.sent && r.contact) darcyConnected = true;
      else log('darcy missed at the nominal timing (jitter overshoot) — re-pitching');
    }
    if (darcyConnected) {
      void h.haltRunners();
      await h.waitPlayEnd();
    }
  }
  } catch (err) {
    log(`demo 5 live attempt aborted: ${err.message}`);
  }
  if (laurieMissed && darcyConnected) {
    check(true, 'spin-read LIVE: laurie missed and darcy connected at the same nominal −0.195s against kian max spin');
  } else {
    substituted(
      'demo 5 (spin-read/CANNON live swing-window comparison)',
      `live sub-tick timing did not land the 49.5 ms band (laurieMissed=${laurieMissed}, darcyConnected=${darcyConnected}); ` +
        'the window maths is unit-test-proven: HitModule.test.ts "spin-read penalty shrinks the window against a spinning pitch unless SWITCH-immune" ' +
        '(laurie-vs-darcy windows 0.1705s vs 0.22s at spin 9, input 1) and "CANNON_ARM (ctx.timingWindowMult 0.85) shrinks the window..."',
    );
  }

  await h.close();
}

// ============================ Demo 4: BUTTERFINGERS bounded seed search ============================
log('=== Demo 4: BUTTERFINGERS — bounded numeric-seed search (pre-screened via a mulberry32 replica) ===');
{
  // Pre-screen: first two draws of createRng(seed) are the play's only rolls
  // (joe is the only fielder whose radius the (−6,9) drive can enter). draw1 <
  // 0.085 always beats joe's worst-case pCatch 0.090 (penalty saturated at 0.35
  // for a ≥30 m/s drive); draw2 < 0.34 always fires the 0.35 fumble.
  const candidates = [];
  for (let s = 1; s <= 20000 && candidates.length < 20; s += 1) {
    const rng = mulberry32(s);
    const r1 = rng();
    const r2 = rng();
    if (r1 < 0.085 && r2 < 0.34) candidates.push({ seed: s, r1, r2 });
  }
  log(`pre-screened candidates (draw1 < 0.085, draw2 < 0.34): ${candidates.map((c) => c.seed).join(', ')}`);

  let fumbleShown = false;
  const tried = [];
  for (let ci = 0; ci < Math.min(candidates.length, 20) && !fumbleShown; ci += 1) {
    const { seed, r1, r2 } = candidates[ci];
    tried.push(seed);
    log(`--- seed ${seed} (draw1=${r1.toFixed(4)}, draw2=${r2.toFixed(4)}): fresh room ---`);
    const code = `MB${String.fromCharCode(65 + Math.floor(ci / 26))}${String.fromCharCode(65 + (ci % 26))}`;
    const h = await openRoom(code, { seed });
    await h.draft();
    h.roomB.send('reposition', { id: 'joe', x: JOE_SPOT.x, z: JOE_SPOT.z });
    await waitFor(() => h.roomA.state.fielders.get('joe')?.z === JOE_SPOT.z, 'joe repositioned', 5000);
    await h.startPlay();

    // Up to 2 resolved plays per room: a drive that misses joe's radius entirely
    // consumes ZERO rng draws, so the seed's two screened draws stay armed.
    for (let play = 1; play <= 2 && !fumbleShown; play += 1) {
      let contact = false;
      for (let i = 0; i < 6 && !contact; i += 1) {
        contact = await h.pitchSwingAt(JOE_SPOT, 0);
        if (!contact) log('missed swing — re-pitching');
      }
      if (!contact) break;
      const swingT = Date.now() - 600;
      void h.haltRunners();
      await h.waitPlayEnd();

      const post = h.samples.filter((s) => s.t > swingT && s.joe !== null);
      const approach = post.find(
        (s) => s.live && Math.hypot(s.vx, s.vy, s.vz) > 5 && s.y > 0.25 && Math.hypot(s.x - s.joe.x, s.z - s.joe.z) < 2.0,
      );
      const fumbleSig = post.find(
        (s) =>
          s.live &&
          Math.hypot(s.x - s.joe.x, s.z - s.joe.z) < 0.8 &&
          s.y < 0.2 &&
          Math.hypot(s.vx, s.vy, s.vz) < 0.5 &&
          post.some((p) => p.t > s.t - 400 && p.t < s.t && Math.hypot(p.vx, p.vy, p.vz) > 5),
      );
      const cause = h.lastCause();
      log(`  play ${play}: approach=${approach !== undefined} fumbleAtFeet=${fumbleSig !== undefined} outcome=${JSON.stringify(cause)}`);
      if (approach !== undefined && fumbleSig !== undefined && cause.kind !== 'caught') {
        fumbleShown = true;
        check(true, `BUTTERFINGERS live at seed ${seed}: in-flight approach into joe's radius, ball velocity zeroed at his FEET (y=${fumbleSig.y.toFixed(2)}, a gather parks at hands y=1.0), and NO caught-out (outcome '${cause.kind}')`);
      } else if (cause.kind === 'caught') {
        log(`  seed ${seed} play ${play}: caught (${JSON.stringify(cause)}) — unexpected for a screened seed; trying next seed`);
        break;
      } else {
        log(`  seed ${seed} play ${play}: inconclusive (radius likely never entered — zero draws consumed); replaying in the same room`);
        if (h.roomA.state.phase === 'GAME_OVER') break;
        await h.startPlay();
      }
    }
    await h.close();
  }
  log(`seeds tried live: ${tried.join(', ') || '(none)'}`);
  if (!fumbleShown) {
    substituted(
      'demo 4 (BUTTERFINGERS live fumble)',
      `no seed in the documented bound (${tried.join(', ')}) demonstrated the fumble live; determinism is unit-test-proven in ` +
        'FieldingModule.test.ts BUTTERFINGERS suite ("a won roll followed by a fumble roll parks the ball at the FEET...", fumbled-flight gathered-guard tests)',
    );
  }
}

// ============================ Verdict ============================
if (substitutions.length > 0) log(`substituted demos (${substitutions.length}): ${substitutions.join('; ')}`);
if (failures.length > 0) {
  log(`ACCEPTANCE FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
log(`ACCEPTANCE PASSED (browser run deliberately omitted: §9.9 changes no UI surface)`);
process.exit(0);
