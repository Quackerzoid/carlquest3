import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, ColyseusTestServer } from '@colyseus/testing';
import type { Room } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import { CHARACTERS, CONST, type PlayOutcome } from '@carlquest/shared';
import appConfig from '../src/app.config';
import { MatchState } from '../src/rooms/MatchState';

/** Server-side room handle as returned by `colyseus.createRoom<MatchState>(...)`. */
type TestRoom = Room<MatchState>;
/** Client-side room handle as returned by `colyseus.connectTo<MatchState>(...)`. */
type TestClient = ClientRoom<MatchState>;

const { FIELD } = CONST;

/**
 * The demo fielding side, derived from the shared roster exactly as MatchRoom
 * builds it (every non-Carl entry, in table order, up to the number of fielding
 * slots) so this expectation cannot drift from the room's own selection.
 */
const FIELDING_IDS = CHARACTERS.filter((c) => c.id !== 'carl')
  .slice(0, FIELD.FIELDING_POSITIONS.length)
  .map((c) => c.id);

/** rng() that always misses every real roster's pCatch (mirrors FieldingModule.test.ts convention). */
const ALWAYS_MISS = (): number => 0.999;
/** rng() that always wins the catch roll on the first radius entry. */
const ALWAYS_CATCH = (): number => 0;

describe('MatchRoom', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    colyseus = await boot(appConfig);
  });
  afterAll(async () => {
    await colyseus.shutdown();
  });
  afterEach(async () => {
    // Every test leaves its room's 60 Hz setSimulationInterval running until
    // disposed; without this, dozens of live rooms accumulate over the file
    // and starve later tests' event-loop timing, occasionally letting the
    // physics catch-up clamp (SIM_MAX_CATCHUP) skip clean over a discrete
    // post-sensor poll — observed as rare flakiness in the run-out test.
    await colyseus.cleanup();
    vi.restoreAllMocks();
  });

  it('boots and lets a client join the match room in LOBBY phase', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    // The colyseus.js client applies the initial full-state snapshot
    // asynchronously after the join handshake resolves, so reading
    // `client.state` immediately after `connectTo` races that decode step
    // (observed intermittently as `client.state.phase === undefined`).
    // `onStateChange` fires once the state has actually been applied —
    // including for this first snapshot, not just later patches — so
    // waiting on it (rather than the server-side `room.waitForNextPatch()`,
    // or the client-side `waitForNextPatch()`, which only resolves on a
    // *subsequent* patch and never fires in this empty room) is the
    // documented way to await readiness of `client.state`. Guard against
    // the opposite race too (state already applied before we subscribe) by
    // checking synchronously first.
    if (client.state.phase === undefined) {
      await new Promise<void>((resolve) => client.onStateChange.once(() => resolve()));
    }
    expect(client.state.phase).toBe('LOBBY');
  });

  it('caps the room at two clients', async () => {
    const room = await colyseus.createRoom('match', {});
    expect(room.maxClients).toBe(2);
  });

  it('pitch while idle makes the ball live with stat-derived speed', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await client.waitForNextPatch();
    expect(client.state.ballLive).toBe(true);
    const speed = Math.hypot(client.state.ball.vx, client.state.ball.vy, client.state.ball.vz);
    expect(speed).toBeGreaterThan(20); // Kian pitch 8 → 26.4 m/s minus a tick of damping/gravity coupling
    expect(speed).toBeLessThan(27);
  });

  it('rejects a second pitch while the ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    const before = { ...room.state.ball };
    client.send('pitch', { aim: { x: 1, y: 0, z: 0 }, spinInput: 1 });
    await room.waitForNextSimulationTick();
    // Velocity direction unchanged (second pitch ignored; ball still travelling -z)
    expect(room.state.ball.vz).toBeLessThan(0);
    expect(Math.sign(room.state.ball.vx)).toBe(Math.sign(before.vx));
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a swing when no ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a pitch message sent with no payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch');
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a swing message sent with a null payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('swing', null);
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('stays responsive to a valid pitch after payload-less pitch/swing messages', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch');
    await room.waitForNextSimulationTick();
    client.send('swing', null);
    await room.waitForNextSimulationTick();
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    // The pitch handler sets ballLive immediately, but the ball's velocity is
    // only written into the schema by the *following* tick(). Because
    // waitForNextSimulationTick is a fixed timer rather than a real per-tick
    // barrier, a single wait can occasionally return before that tick has run,
    // leaving the schema velocity at its stale zero. Poll until the stepped
    // velocity actually lands so this asserts the pitch's real speed, not a race.
    for (let i = 0; i < 30; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0) break;
    }
    await client.waitForNextPatch();
    expect(client.state.ballLive).toBe(true);
    const speed = Math.hypot(client.state.ball.vx, client.state.ball.vy, client.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);
  });

  it('full loop: pitch, wait for plane crossing, swing connects and reverses flight', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    // Ball travels ~7.5 m at ~26.4 m/s ≈ 0.284 s ≈ 17 ticks. Poll until it nears the plane.
    for (let i = 0; i < 60; i += 1) {
      await room.waitForNextSimulationTick();
      // `waitForNextSimulationTick` is a fixed setTimeout, not a real barrier
      // on the room's own tick (see @colyseus/testing's Room.ext.js), and
      // `ball.z` defaults to 0 (a false "near the plane" reading) before the
      // very first tick applies the pitch — so this must also require
      // `ballLive`, or a slow first tick can make this fire on iteration 0.
      if (room.state.ballLive && room.state.ball.z < 0.5) break;
    }
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await room.waitForNextSimulationTick();
    // A connected hit sends the ball back out (+z-ish per the demo aim) at hit speed.
    expect(room.state.ball.vz).toBeGreaterThan(0);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(10);
  }, 15000);

  /**
   * Poll until the pitched ball is genuinely near the batting-square plane.
   *
   * `waitForNextSimulationTick` is a fixed setTimeout, not a real barrier on the
   * room's own tick (see @colyseus/testing's Room.ext.js), and `ball.z` defaults
   * to 0 — a false "near the plane" reading — between the tick that sets
   * `ballLive` (in the pitch handler) and the *next* tick that first writes the
   * ball's real position into the schema. So requiring `ballLive && ball.z < 0.5`
   * alone can fire on iteration 0 while the ball is still stale at z = 0, making
   * the caller swing far too early (a guaranteed miss). Latch on having first
   * seen the ball genuinely in flight (z well past the plane) before accepting a
   * near-plane reading, which eliminates that early-swing false positive.
   */
  async function waitNearPlane(room: TestRoom): Promise<void> {
    let sawInFlight = false;
    for (let i = 0; i < 120; i += 1) {
      await room.waitForNextSimulationTick();
      if (!room.state.ballLive) continue;
      if (room.state.ball.z > 1) sawInFlight = true; // real, stepped position (pitch starts at z ≈ 7.5)
      if (sawInFlight && room.state.ball.z < 0.5) break;
    }
  }

  /** Pitch straight, poll until the ball nears the batting plane, then swing with the given aim/spin. */
  async function pitchThenSwing(
    room: TestRoom,
    client: TestClient,
    aim: { x: number; y: number; z: number },
  ): Promise<void> {
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await waitNearPlane(room);
    client.send('swing', { timing: 0, aim, spinInput: 0 });
    await room.waitForNextSimulationTick();
  }

  /**
   * Like `pitchThenSwing`, but aims relative to the ball's actual current
   * position (server-authoritative, read synchronously — no network
   * latency) rather than a literal fixed aim vector, and swings deliberately
   * `lateTicks` after the ball nears the plane. A "late" swing (real but
   * modest timing error, still within the reflex timing window) trades exit
   * speed for a much smaller per-tick travel distance near the target —
   * post-bounce the ball is rolling, not flying, so it dwells inside the
   * post's ~0.5 m run-out sensor across several ticks rather than crossing
   * it in one, which is far more robust against `waitForNextSimulationTick`
   * being a fixed timer rather than a real per-tick barrier (see
   * @colyseus/testing's Room.ext.js) under real (jittery) event-loop timing.
   */
  async function pitchThenSwingAtTarget(
    room: TestRoom,
    client: TestClient,
    target: { x: number; z: number },
    lateTicks: number,
    aimY = 0,
  ): Promise<void> {
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await waitNearPlane(room);
    for (let i = 0; i < lateTicks; i += 1) {
      await room.waitForNextSimulationTick();
    }
    // The swing is applied at the ball's position roughly one tick AFTER we read
    // it here (the message lands on the next room tick), by which point the ball
    // has drifted ≈ v·dt further down the -z pitch line. Aiming from the raw read
    // position therefore launches the hit off a parallel line, missing the post
    // by the perpendicular component of that drift (≈0.4 m — right at the 0.5 m
    // sensor edge). Aim from the predicted one-tick-ahead contact point instead,
    // which cancels the bulk of that offset. (Residual sub-tick jitter is small
    // enough that every caller is single-attempt — all retries were removed.)
    //
    // `aimY` sets the vertical aim component; the default 0 is a flat drive.
    // A very large negative value is clamped by HitModule to exactly
    // GAME.HIT_ELEVATION_MIN_DEG (−10°), giving a deterministic downward hit.
    const dt = CONST.PHYSICS.FIXED_TIMESTEP;
    const cx = room.state.ball.x + room.state.ball.vx * dt;
    const cz = room.state.ball.z + room.state.ball.vz * dt;
    client.send('swing', { timing: 0, aim: { x: target.x - cx, y: aimY, z: target.z - cz }, spinInput: 0 });
    await room.waitForNextSimulationTick();
  }

  it('fielders start at their FIELDING_POSITIONS slots (9 fielders, kian on the bowler slot)', async () => {
    const room = await colyseus.createRoom('match', {});
    expect(room.state.fielders.size).toBe(9);
    FIELDING_IDS.forEach((id, i) => {
      const f = room.state.fielders.get(id);
      const slot = FIELD.FIELDING_POSITIONS[i];
      expect(f).toBeDefined();
      expect(f?.x).toBeCloseTo(slot?.x ?? NaN, 9);
      expect(f?.z).toBeCloseTo(slot?.z ?? NaN, 9);
    });
    // Slot 0 (bowler) must be Kian, matching CLAUDE.md's demo-cast decision.
    const bowler = room.state.fielders.get('kian');
    expect(bowler?.x).toBeCloseTo(FIELD.BOWLING_SQUARE.x, 9);
    expect(bowler?.z).toBeCloseTo(FIELD.BOWLING_SQUARE.z, 9);
  });

  it('a connected hit starts a runner heading towards post 1', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await pitchThenSwing(room, client, { x: 0.5, y: 0.3, z: 1 });
    await room.waitForNextSimulationTick();
    expect(room.state.runner.id).toBe('carl');
    expect(room.state.runner.running).toBe(true);
    expect(room.state.runner.atPost).toBe(-1);
    expect(room.state.runner.out).toBe(false);
  });

  it('runDecision {go:false} halts the runner at post 1, and the play eventually ends safe there', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await pitchThenSwing(room, client, { x: 0.5, y: 0.3, z: 1 });
    client.send('runDecision', { go: false });

    let haltedAtPost1 = false;
    for (let i = 0; i < 600 && room.state.ballLive; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.runner.atPost === 1 && !room.state.runner.running) haltedAtPost1 = true;
    }

    expect(haltedAtPost1).toBe(true);
    expect(room.state.ballLive).toBe(false);
    const outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
    expect(outcome).toEqual({ kind: 'safe', atPost: 1, runnerId: 'carl' });
  }, 20000);

  it('rejects runDecision when no live ball, no active runner, or a malformed payload', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);

    // No live ball / no runner at all yet.
    client.send('runDecision', { go: true });
    await room.waitForNextSimulationTick();
    expect(room.state.demoLog).toContain('rejected');

    // Malformed payload (non-boolean `go`).
    client.send('runDecision', { go: 'yes' });
    await room.waitForNextSimulationTick();
    expect(room.state.demoLog).toContain('rejected');

    // Payload-less message must not crash the room.
    client.send('runDecision');
    await room.waitForNextSimulationTick();
    expect(room.state.demoLog).toContain('rejected');
    expect(room.state.ballLive).toBe(false);
  });

  it('a hit flown directly at an exposed post is a run-out (event-accurate sensor)', async () => {
    const post1 = FIELD.POSTS[0];
    if (post1 === undefined) throw new Error('no post 1 in fixture');

    // Detection is now event-accurate: physics.wasBallAtPost latches the sensor
    // intersection per substep (CLAUDE.md §6.4), so the crossing cannot be lost
    // between the room's once-per-tick polls even when `waitForNextSimulationTick`'s
    // fixed timer lets a tick fold several substeps together. No retry needed —
    // a single deterministic attempt asserts the outcome directly.
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    let received: PlayOutcome | null = null;
    client.onMessage('playOutcome', (payload: PlayOutcome) => {
      received = payload;
    });

    // Aim the hit straight down the line to post 1 (11.7 m away at ~34 m/s): the
    // ball reaches the post's run-out sensor long before Carl (6.35 m/s) can
    // cover the same distance on foot, so the runner is still mid-segment.
    await pitchThenSwingAtTarget(room, client, post1, 0);

    let outcome: PlayOutcome | null = null;
    for (let i = 0; i < 120 && outcome === null; i += 1) {
      await room.waitForNextSimulationTick();
      if (!room.state.ballLive) outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
    }
    // The 'playOutcome' broadcast reaches the client a moment after the
    // server-side state is already updated; give it one more tick to land.
    await room.waitForNextSimulationTick();
    expect(outcome).toEqual({ kind: 'runOut', atPost: 1, runnerId: 'carl' });
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(outcome);
    // Fielders are reset back to their starting slots once the play ends.
    const bowler = room.state.fielders.get('kian');
    expect(bowler?.x).toBeCloseTo(FIELD.BOWLING_SQUARE.x, 9);
    expect(bowler?.z).toBeCloseTo(FIELD.BOWLING_SQUARE.z, 9);
  }, 20000);

  it('a stale post crossing from earlier in flight does not run the runner out on later exposure', async () => {
    // Regression (task-5 fix round 2): the hit ball flies through post 2's
    // run-out sensor early in flight — long before the runner is exposed to
    // post 2 — and rolls away un-gathered (ALWAYS_MISS: nobody ever holds it).
    // The runner halts safely at post 1, and only THEN sets off for post 2. A
    // naive segment-lifetime latch would read the stale post-2 crossing the
    // moment exposedPost() becomes 2 and wrongly run them out on a contact
    // that predates their exposure; crossings must be scoped to the current
    // exposure window ("ball at the exposed post WHILE exposed").
    const post2 = FIELD.POSTS[1];
    if (post2 === undefined) throw new Error('no post 2 in fixture');
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);

    // Hit flown straight through post 2's sensor; runner sets off towards post 1.
    await pitchThenSwingAtTarget(room, client, post2, 0);
    client.send('runDecision', { go: false }); // halt at post 1

    let haltedAtPost1 = false;
    for (let i = 0; i < 240 && room.state.ballLive && !haltedAtPost1; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.runner.atPost === 1 && !room.state.runner.running) haltedAtPost1 = true;
    }
    expect(haltedAtPost1).toBe(true);
    expect(room.state.ballLive).toBe(true); // ball still rolling out; play live

    // Resume towards post 2 — the moment the stale latch would fire.
    client.send('runDecision', { go: true });
    for (let i = 0; i < 60 && room.state.ballLive; i += 1) {
      await room.waitForNextSimulationTick();
    }

    // With the fix the runner is never run out by the stale crossing: either
    // the play is still live (runner en route / beyond post 2) or it has since
    // ended for a non-run-out reason (safe/rounder at rest/timeout).
    expect(room.state.runner.out).toBe(false);
    if (!room.state.ballLive) {
      const outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
      expect(outcome.kind).not.toBe('runOut');
    }
  }, 20000);

  it('a crossing while the runner is HALTED does not run them out on the later go', async () => {
    // Regression (final-review round 2): the runner halts safely at post 1
    // (the halt transition clears the latches and sets lastExposedPost null);
    // while they sit there, the still-live ball rolls THROUGH post 2's sensor
    // and out the far side — the latch is set and NOTHING clears it, because
    // exposure stays null. The go decision then arrives BETWEEN ticks
    // (runDecision handler), flipping exposure null → 2 outside any tick. On
    // the next tick the pre-fielding snapshot must NOT honour that stale
    // latch: the crossing predates the post-2 exposure window, so running the
    // runner out from it would be wrongful (the ball is long gone).
    //
    // Vehicle: a deliberately WEAK hit — the swing is sent only once the ball
    // is well past the batting plane (z < −3.3, a real ~9-tick timing error),
    // so the exit speed collapses to ~5-12 m/s and the ball ROLLS up the line
    // through post 2, arriving ~2-4 s in — comfortably after the halted
    // runner reached post 1 at ~1.84 s. ALWAYS_MISS keeps every fielder's
    // hands off it. The slowest sub-tick jitter band can instead time the
    // play out before the ball arrives; that path degrades to a vacuous but
    // still-green pass of the same assertion (the RED evidence in the task-7
    // report pins that the repro band is what actually runs).
    const post2 = FIELD.POSTS[1];
    if (post2 === undefined) throw new Error('no post 2 in fixture');
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);

    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    let sawInFlight = false;
    for (let i = 0; i < 180; i += 1) {
      await room.waitForNextSimulationTick();
      if (!room.state.ballLive) continue;
      if (room.state.ball.z > 1) sawInFlight = true;
      if (sawInFlight && room.state.ball.z < -3.3) break; // deliberately LATE (weak hit)
    }
    const dt = CONST.PHYSICS.FIXED_TIMESTEP;
    const cx = room.state.ball.x + room.state.ball.vx * dt;
    const cz = room.state.ball.z + room.state.ball.vz * dt;
    client.send('swing', { timing: 0, aim: { x: post2.x - cx, y: 0, z: post2.z - cz }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.demoLog).toContain('hit'); // the late swing must still connect
    client.send('runDecision', { go: false }); // halt at post 1

    let halted = false;
    for (let i = 0; i < 300 && room.state.ballLive && !halted; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.runner.atPost === 1 && !room.state.runner.running) halted = true;
    }
    expect(halted).toBe(true);

    // Wait until the ball has passed THROUGH the sensor and gone (its path
    // runs within ~0.2 m of the post, so distance > radius + 0.3 with z past
    // the post means genuinely through and out, not still inside).
    let passed = false;
    for (let i = 0; i < 600 && room.state.ballLive && !passed; i += 1) {
      await room.waitForNextSimulationTick();
      const dx = room.state.ball.x - post2.x;
      const dz = room.state.ball.z - post2.z;
      if (room.state.ball.z > post2.z && Math.hypot(dx, dz) > FIELD.POST_SENSOR_RADIUS + 0.3) passed = true;
    }

    if (passed) {
      client.send('runDecision', { go: true }); // exposure flips null → 2 between ticks
      for (let i = 0; i < 240 && room.state.ballLive; i += 1) {
        await room.waitForNextSimulationTick();
      }
    }
    // However the play ends (safe mid-run at timeout, rounder, …), the stale
    // while-halted crossing must never have produced a run-out.
    expect(room.state.runner.out).toBe(false);
    if (!room.state.ballLive && room.state.lastOutcome !== '') {
      const outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
      expect(outcome.kind).not.toBe('runOut');
    }
  }, 30000);

  it('a hit flown straight at the bowler is caught (pre-bounce)', async () => {
    // Aimed straight back down the pitch line at the bowler with a
    // guaranteed-catch rng: the ball flies flat into a fielder's catch radius
    // within a few ticks, well before it can bounce, so `caught` is
    // deterministic and this is a single attempt. WHICH fielder takes it is
    // deliberately not pinned: a swing that lands a sub-tick late (the
    // `waitForNextSimulationTick` fixed-timer jitter) puts contact slightly
    // behind the plane, occasionally inside the long-reach backstop (Laurie)'s
    // radius before Kian's — who catches is nearest-fielder jitter, not what
    // this test protects (pre-bounce catch → caught outcome resolution).
    const room = await colyseus.createRoom('match', { rng: ALWAYS_CATCH });
    const client = await colyseus.connectTo(room);
    let received: PlayOutcome | null = null;
    client.onMessage('playOutcome', (payload: PlayOutcome) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);

    let outcome: PlayOutcome | null = null;
    for (let i = 0; i < 90 && outcome === null; i += 1) {
      await room.waitForNextSimulationTick();
      if (!room.state.ballLive) outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
    }
    // The 'playOutcome' broadcast reaches the client a moment after the
    // server-side state is already updated; give it one more tick to land.
    await room.waitForNextSimulationTick();

    expect(outcome?.kind).toBe('caught');
    expect(FIELDING_IDS).toContain((outcome as Extract<PlayOutcome, { kind: 'caught' }>).by);
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(outcome);
  }, 20000);

  it('a gathered ball is thrown to the exposed post for a run-out (full throw pipeline)', async () => {
    // End-to-end marquee pipeline: hit → bounce → fielder gathers (post-bounce)
    // → THROW_RELEASE_DELAY_S hold → applyThrow → thrown ball crosses the
    // exposed post's sensor → runOut. Deterministic geometry:
    //
    // - The hit is aimed at the BOWLING_SQUARE with a huge negative aimY, which
    //   HitModule clamps to exactly −10° elevation — the ball dives into the
    //   ground ≤ 3.7 m out and hops down the x = 0 line into Kian's radius
    //   (entry at z ≥ ~4.4: he advances ~1 m while the ball covers ~5 m, and a
    //   near-plane contact caps the bounce distance), so Kian's entry is
    //   always post-bounce → a GATHER, never a catch.
    // - The rng is scripted by SERVER STATE, not call order (contact can land
    //   just behind the plane, inside the backstop Laurie's 2.78 m radius, so
    //   whether she rolls first is sub-tick jitter): a roll wins exactly when
    //   the ball is in the mid-corridor gather zone (|x| < 1, z > 2). Laurie's
    //   roll happens at the contact point (z ≤ 0.5) and the post-1 cover
    //   fielder's (Josh's) at x ≈ 9 during the throw — both miss — while
    //   Kian's gather (x ≈ 0, z ≥ ~4.4) is the only roll inside the zone.
    // - Kian gathers ~11 m from post 1 while the runner (6.35 m/s over 11.7 m,
    //   arriving ~1.84 s) is barely a third of the way there; after the 0.5 s
    //   release delay his 26.4 m/s throw reaches post 1 at ~1.2 s — a ≥ 35-tick
    //   margin on every leg, so this is single-attempt deterministic. The hit
    //   ball itself never goes near post 1 (its line is x ≈ 0; post 1 is at
    //   x = 11), so a runOut at post 1 can ONLY be the thrown ball.
    // roomRef is late-bound (the rng must exist before createRoom returns the
    // room), but this is not a use-before-assign hazard: rolls only occur
    // mid-play — fielding is gated on a live runner, long after roomRef is set.
    let roomRef: TestRoom | null = null;
    const corridorGatherRng = (): number => {
      const b = roomRef?.state.ball; // written earlier in the same tick as the roll
      return b !== undefined && Math.abs(b.x) < 1 && b.z > 2 ? 0 : 0.999;
    };
    const room = await colyseus.createRoom('match', { rng: corridorGatherRng });
    roomRef = room;
    const client = await colyseus.connectTo(room);
    let received: PlayOutcome | null = null;
    client.onMessage('playOutcome', (payload: PlayOutcome) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0, -1000);

    const holders = new Set<string>();
    let outcome: PlayOutcome | null = null;
    for (let i = 0; i < 180 && outcome === null; i += 1) {
      await room.waitForNextSimulationTick();
      for (const f of room.state.fielders.values()) {
        if (f.hasBall) holders.add(f.id);
      }
      if (!room.state.ballLive) outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
    }
    // The 'playOutcome' broadcast reaches the client a moment after the
    // server-side state is already updated; give it one more tick to land.
    await room.waitForNextSimulationTick();

    // The ball was held (gathered, then thrown) — this run-out is the throw's.
    expect([...holders]).toEqual(['kian']);
    expect(outcome).toEqual({ kind: 'runOut', atPost: 1, runnerId: 'carl' });
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(outcome);
  }, 20000);

  it('garbage rng/seed join options cannot break the room (runtime-validated)', async () => {
    // Room-creation options arrive off the wire (any client's joinOrCreate
    // options object reaches onCreate), so the compile-time shape is advisory:
    // a non-function `rng` must not throw inside the simulation interval and a
    // non-numeric `seed` must not poison the catch rolls — the room must
    // validate at runtime and fall through to its own wall-clock-seeded rng.
    const errorSpy = vi.spyOn(console, 'error');
    const garbage = { rng: 1, seed: 'not-a-number' } as unknown as Record<string, unknown>;
    const room = await colyseus.createRoom('match', garbage);
    const client = await colyseus.connectTo(room);

    // Pitch still works with stat-derived speed…
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    for (let i = 0; i < 30; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0) break;
    }
    expect(room.state.ballLive).toBe(true);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);

    // …and a connected swing back down the pitch line drives the ball through
    // Kian's catch radius, forcing real deps.rng() calls. The fallback rng is
    // wall-clock seeded, so WHICH outcome resolves is deliberately unpinned;
    // what this asserts is that the play keeps simulating and terminates
    // (worst case rest/timeout) instead of erroring in the tick loop.
    await waitNearPlane(room);
    client.send('swing', { timing: 0, aim: { x: 0, y: 0, z: 1 }, spinInput: 0 });
    let ended = false;
    for (let i = 0; i < 600 && !ended; i += 1) {
      await room.waitForNextSimulationTick();
      if (!room.state.ballLive) ended = true;
    }
    expect(ended).toBe(true);
    const outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
    expect(['caught', 'runOut', 'rounder', 'safe']).toContain(outcome.kind);
    // No tick-loop exceptions were swallowed along the way.
    const uncaught = errorSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[MatchRoom] uncaught exception'),
    );
    expect(uncaught).toEqual([]);
  }, 30000);
});
