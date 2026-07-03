import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
    // which cancels the bulk of that offset. (Residual sub-tick jitter is what
    // the small retry in the caller absorbs.)
    const dt = CONST.PHYSICS.FIXED_TIMESTEP;
    const cx = room.state.ball.x + room.state.ball.vx * dt;
    const cz = room.state.ball.z + room.state.ball.vz * dt;
    client.send('swing', { timing: 0, aim: { x: target.x - cx, y: 0, z: target.z - cz }, spinInput: 0 });
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
    expect(outcome).toEqual({ kind: 'safe', atPost: 1 });
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
    expect(outcome).toEqual({ kind: 'runOut', atPost: 1 });
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(outcome);
    // Fielders are reset back to their starting slots once the play ends.
    const bowler = room.state.fielders.get('kian');
    expect(bowler?.x).toBeCloseTo(FIELD.BOWLING_SQUARE.x, 9);
    expect(bowler?.z).toBeCloseTo(FIELD.BOWLING_SQUARE.z, 9);
  }, 20000);

  it('a hit flown straight at the bowler is caught (pre-bounce)', async () => {
    // Aimed straight back down the pitch line at Kian (the bowler, slot 0) with a
    // guaranteed-catch rng, so a fielder catches pre-bounce and the play resolves
    // `caught`. This is the ONE test that keeps a minimal retry, and it is not
    // about detection: outcome resolution and the pre-bounce catch are exercised
    // every attempt. The residual nondeterminism is purely WHICH fielder is
    // nearest the ball at the contact tick — `waitForNextSimulationTick` is a
    // fixed timer, not a per-tick barrier (@colyseus/testing's Room.ext.js), so a
    // swing that lands a sub-tick late puts contact slightly behind the plane,
    // occasionally inside the long-reach backstop (Laurie)'s radius before Kian's.
    // A fresh-room retry re-samples that message-landing jitter; the run-out test
    // above needs no retry because event-accurate wasBallAtPost removed the only
    // detection-side flake.
    const isKianCatch = (o: PlayOutcome | null): boolean => o?.kind === 'caught' && o.by === 'kian';
    let outcome: PlayOutcome | null = null;
    let received: PlayOutcome | null = null;
    for (let attempt = 0; attempt < 3 && !isKianCatch(outcome); attempt += 1) {
      const room = await colyseus.createRoom('match', { rng: ALWAYS_CATCH });
      const client = await colyseus.connectTo(room);
      received = null;
      client.onMessage('playOutcome', (payload: PlayOutcome) => {
        received = payload;
      });

      await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);

      outcome = null;
      for (let i = 0; i < 90 && outcome === null; i += 1) {
        await room.waitForNextSimulationTick();
        if (!room.state.ballLive) outcome = JSON.parse(room.state.lastOutcome) as PlayOutcome;
      }
      // The 'playOutcome' broadcast reaches the client a moment after the
      // server-side state is already updated; give it one more tick to land.
      await room.waitForNextSimulationTick();

      if (isKianCatch(outcome)) {
        expect(room.state.ballLive).toBe(false);
        expect(received).toEqual(outcome);
      }
    }

    expect(outcome).toEqual({ kind: 'caught', by: 'kian' });
  }, 20000);
});
