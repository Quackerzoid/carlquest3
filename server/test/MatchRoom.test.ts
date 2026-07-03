import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, ColyseusTestServer } from '@colyseus/testing';
import type { Room } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import { CHARACTERS, CONST, type MatchPhase, type PlayOutcome, type PlayResolution } from '@carlquest/shared';
import appConfig from '../src/app.config';
import { MatchState } from '../src/rooms/MatchState';

/** Server-side room handle as returned by `colyseus.createRoom<MatchState>(...)`. */
type TestRoom = Room<MatchState>;
/** Client-side room handle as returned by `colyseus.connectTo<MatchState>(...)`. */
type TestClient = ClientRoom<MatchState>;

const { FIELD } = CONST;

/**
 * The demo fielding side, derived from the shared roster exactly as MatchRoom
 * builds it (every non-opener entry — CHARACTERS[0] is Carl — in table order, up
 * to the number of fielding slots) so this expectation cannot drift from the
 * room's own selection.
 */
const OPENER_ID = CHARACTERS[0]?.id ?? 'carl';
const FIELDING_IDS = CHARACTERS.filter((c) => c.id !== OPENER_ID)
  .slice(0, FIELD.FIELDING_POSITIONS.length)
  .map((c) => c.id);

/** rng() that always misses every real roster's pCatch (mirrors FieldingModule.test.ts convention). */
const ALWAYS_MISS = (): number => 0.999;
/** rng() that always wins the catch roll on the first radius entry. */
const ALWAYS_CATCH = (): number => 0;

// ---- Shared helpers --------------------------------------------------------

/** Await the client's initial full-state snapshot (guards the connectTo decode race). */
async function awaitClientState(client: TestClient): Promise<void> {
  if (client.state.phase === undefined) {
    await new Promise<void>((resolve) => client.onStateChange.once(() => resolve()));
  }
}

/** Poll server-side room state until it reaches `phase`, or throw. */
async function waitForPhase(room: TestRoom, phase: MatchPhase, maxTicks = 180): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (room.state.phase === phase) return;
    await room.waitForNextSimulationTick();
  }
  throw new Error(`phase ${phase} not reached (stuck at ${room.state.phase})`);
}

/**
 * Walk the phase machine to PLAY: confirmPositioning (INITIAL_POSITIONING →
 * PRE_PLAY) then readyForPlay (PRE_PLAY → PLAY). onJoin has already advanced the
 * first client to INITIAL_POSITIONING; this covers both the very first play and
 * the PRE_PLAY entry after a resolved play.
 */
async function startPlay(room: TestRoom, client: TestClient): Promise<void> {
  if (room.state.phase === 'LOBBY') await waitForPhase(room, 'INITIAL_POSITIONING');
  if (room.state.phase === 'INITIAL_POSITIONING') {
    client.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
  }
  if (room.state.phase === 'PRE_PLAY') {
    client.send('readyForPlay');
    await waitForPhase(room, 'PLAY');
  }
  if (room.state.phase !== 'PLAY') throw new Error(`startPlay left phase at ${room.state.phase}`);
}

/**
 * Poll until the pitched ball is genuinely near the batting-square plane.
 * `waitForNextSimulationTick` is a fixed setTimeout, not a real tick barrier, and
 * `ball.z` defaults to 0 (a false "near the plane" reading) between the tick that
 * sets ballLive and the tick that first writes the ball's real position. Latch on
 * having first seen the ball in flight (z well past the plane) before accepting a
 * near-plane reading, which eliminates that early-swing false positive.
 */
async function waitNearPlane(room: TestRoom): Promise<void> {
  let sawInFlight = false;
  for (let i = 0; i < 120; i += 1) {
    await room.waitForNextSimulationTick();
    if (!room.state.ballLive) continue;
    if (room.state.ball.z > 1) sawInFlight = true;
    if (sawInFlight && room.state.ball.z < 0.5) break;
  }
}

/** Pitch straight, poll until the ball nears the batting plane, then swing with the given aim. Must already be in PLAY. */
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
 * Pitch, then swing `lateTicks` after the ball nears the plane, aiming from the
 * ball's predicted one-tick-ahead contact point at `target` (server-authoritative,
 * read synchronously). `aimY` sets the vertical aim (default 0 = flat drive; a
 * large value is clamped by HitModule to +60°, a large negative to −10°). Must
 * already be in PLAY.
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
  const dt = CONST.PHYSICS.FIXED_TIMESTEP;
  const cx = room.state.ball.x + room.state.ball.vx * dt;
  const cz = room.state.ball.z + room.state.ball.vz * dt;
  client.send('swing', { timing: 0, aim: { x: target.x - cx, y: aimY, z: target.z - cz }, spinInput: 0 });
  await room.waitForNextSimulationTick();
}

/** Poll until the current play resolves (phase leaves PLAY), returning the parsed resolution. */
async function waitPlayEnd(room: TestRoom, maxTicks = 800): Promise<PlayResolution> {
  for (let i = 0; i < maxTicks; i += 1) {
    await room.waitForNextSimulationTick();
    if (room.state.phase !== 'PLAY') break;
  }
  if (room.state.phase === 'PLAY') throw new Error('play did not resolve in time');
  return JSON.parse(room.state.lastOutcome) as PlayResolution;
}

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
    // disposed; without this, live rooms accumulate across the file and starve
    // later tests' event-loop timing.
    await colyseus.cleanup();
    vi.restoreAllMocks();
  });

  // ---- Boot / lobby --------------------------------------------------------

  it('advances the first client to INITIAL_POSITIONING on join (M5 lobby/draft stubs)', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await awaitClientState(client);
    await waitForPhase(room, 'INITIAL_POSITIONING');
    expect(room.state.phase).toBe('INITIAL_POSITIONING');
    // The rules view is mirrored into the schema from the first frame.
    expect(room.state.battingSide).toBe('A');
    expect(room.state.currentBatterId).toBe(OPENER_ID);
    expect(room.state.currentPitcherId).toBe('kian');
  });

  it('caps the room at two clients', async () => {
    const room = await colyseus.createRoom('match', {});
    expect(room.maxClients).toBe(2);
  });

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
    const bowler = room.state.fielders.get('kian');
    expect(bowler?.x).toBeCloseTo(FIELD.BOWLING_SQUARE.x, 9);
    expect(bowler?.z).toBeCloseTo(FIELD.BOWLING_SQUARE.z, 9);
  });

  // ---- Phase walk ----------------------------------------------------------

  it('phase walk: join → INITIAL_POSITIONING → PRE_PLAY → PLAY → (caught) → PRE_PLAY with an out', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_CATCH });
    const client = await colyseus.connectTo(room);
    await awaitClientState(client);

    await waitForPhase(room, 'INITIAL_POSITIONING');
    client.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
    expect(room.state.phase).toBe('PRE_PLAY');
    client.send('readyForPlay');
    await waitForPhase(room, 'PLAY');
    expect(room.state.phase).toBe('PLAY');

    // Drive a caught out → resolves back to PRE_PLAY with outs incremented.
    await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);
    const res = await waitPlayEnd(room);
    expect(room.state.phase).toBe('PRE_PLAY');
    expect(res.cause.kind).toBe('caught');
    expect(room.state.outs).toBe(1);
    expect(room.state.currentBatterId).not.toBe(OPENER_ID); // batter rotated on
  });

  // ---- Pitch / swing basics (migrated onto the phase machine) --------------

  it('pitch while in PLAY makes the ball live with stat-derived speed', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    for (let i = 0; i < 30; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0) break;
    }
    expect(room.state.ballLive).toBe(true);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20); // Kian pitch 8 → 26.4 m/s minus a tick of damping
    expect(speed).toBeLessThan(27);
  });

  it('rejects a second pitch while the ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    const before = { vx: room.state.ball.vx, vz: room.state.ball.vz };
    client.send('pitch', { aim: { x: 1, y: 0, z: 0 }, spinInput: 1 });
    await room.waitForNextSimulationTick();
    expect(room.state.ball.vz).toBeLessThan(0);
    expect(Math.sign(room.state.ball.vx)).toBe(Math.sign(before.vx));
    expect(room.state.lastRejection).toContain('pitch');
  });

  it('rejects a swing when no ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.lastRejection).toContain('swing');
  });

  it('rejects a pitch message sent with no payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('pitch');
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.lastRejection).toContain('pitch');
  });

  it('rejects a swing message sent with a null payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('swing', null);
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.lastRejection).toContain('swing');
  });

  it('stays responsive to a valid pitch after payload-less pitch/swing messages', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('pitch');
    await room.waitForNextSimulationTick();
    client.send('swing', null);
    await room.waitForNextSimulationTick();
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    for (let i = 0; i < 30; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0) break;
    }
    expect(room.state.ballLive).toBe(true);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);
  });

  it('full loop: pitch, wait for plane crossing, swing connects and reverses flight', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await waitNearPlane(room);
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await room.waitForNextSimulationTick();
    expect(room.state.ball.vz).toBeGreaterThan(0);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(10);
  }, 15000);

  // ---- Running -------------------------------------------------------------

  it('a connected hit starts a runner heading towards post 1', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    await pitchThenSwing(room, client, { x: 0.5, y: 0.3, z: 1 });
    await room.waitForNextSimulationTick();
    const runner = room.state.runners.get('carl');
    expect(runner).toBeDefined();
    expect(runner?.running).toBe(true);
    expect(runner?.atPost).toBe(-1);
    expect(runner?.out).toBe(false);
  });

  it('runDecision {go:false} halts the runner at post 1, and the play ends safe there', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    await pitchThenSwing(room, client, { x: 0.5, y: 0.3, z: 1 });
    client.send('runDecision', { go: false });

    let haltedAtPost1 = false;
    for (let i = 0; i < 600 && room.state.ballLive; i += 1) {
      await room.waitForNextSimulationTick();
      const r = room.state.runners.get('carl');
      if (r?.atPost === 1 && !r.running) haltedAtPost1 = true;
    }

    expect(haltedAtPost1).toBe(true);
    expect(room.state.ballLive).toBe(false);
    const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
    expect(res.cause).toEqual({ kind: 'safe', atPost: 1, runnerId: 'carl' });
    expect(res.outs).toEqual([]);
    expect(res.scoreDeltaHalves).toBe(0); // post 1 < 2, banks nothing
  }, 20000);

  it('rejects runDecision when no live ball, no active runner, or a malformed payload', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);

    client.send('runDecision', { go: true });
    await room.waitForNextSimulationTick();
    expect(room.state.lastRejection).toContain('runDecision');

    client.send('runDecision', { go: 'yes' });
    await room.waitForNextSimulationTick();
    expect(room.state.lastRejection).toContain('runDecision');

    client.send('runDecision');
    await room.waitForNextSimulationTick();
    expect(room.state.lastRejection).toContain('runDecision');
    expect(room.state.ballLive).toBe(false);
  });

  // ---- Run-out detection (migrated) ----------------------------------------

  it('a hit flown directly at an exposed post is a run-out (event-accurate sensor)', async () => {
    const post1 = FIELD.POSTS[0];
    if (post1 === undefined) throw new Error('no post 1 in fixture');

    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    let received: PlayResolution | null = null;
    client.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, client, post1, 0);

    const res = await waitPlayEnd(room, 200);
    await room.waitForNextSimulationTick(); // let the broadcast land
    expect(res.cause).toEqual({ kind: 'runOut', atPost: 1, runnerId: 'carl' });
    expect(res.outs).toContain('carl');
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(res);
    const bowler = room.state.fielders.get('kian');
    expect(bowler?.x).toBeCloseTo(FIELD.BOWLING_SQUARE.x, 9);
    expect(bowler?.z).toBeCloseTo(FIELD.BOWLING_SQUARE.z, 9);
  }, 20000);

  it('a stale post crossing from earlier in flight does not run the runner out on later exposure', async () => {
    const post2 = FIELD.POSTS[1];
    if (post2 === undefined) throw new Error('no post 2 in fixture');
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);

    await pitchThenSwingAtTarget(room, client, post2, 0);
    client.send('runDecision', { go: false }); // halt at post 1

    let haltedAtPost1 = false;
    for (let i = 0; i < 240 && room.state.ballLive && !haltedAtPost1; i += 1) {
      await room.waitForNextSimulationTick();
      const r = room.state.runners.get('carl');
      if (r?.atPost === 1 && !r.running) haltedAtPost1 = true;
    }
    expect(haltedAtPost1).toBe(true);
    expect(room.state.ballLive).toBe(true);

    client.send('runDecision', { go: true }); // resume towards post 2 — the stale-latch moment
    for (let i = 0; i < 60 && room.state.ballLive; i += 1) {
      await room.waitForNextSimulationTick();
    }

    expect(room.state.runners.get('carl')?.out).toBe(false);
    if (!room.state.ballLive) {
      const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
      expect(res.cause.kind).not.toBe('runOut');
    }
  }, 20000);

  it('a crossing while the runner is HALTED does not run them out on the later go', async () => {
    const post2 = FIELD.POSTS[1];
    if (post2 === undefined) throw new Error('no post 2 in fixture');
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);

    // A near-plane (reliable, factor≈1) LOW −10° drive aimed at post 2: it blasts
    // through post 2's run-out sensor while Carl is still heading to post 1
    // (exposure = post 1). Carl then HALTS at post 1 — the halt changes the
    // exposure set, clearing the post-2 crossing latch — and the ball rolls on
    // and out. When Carl later resumes (go), exposure flips null → 2 between
    // ticks over a now-cleared latch; the invariant under test is that this stale
    // crossing NEVER runs him out, however the play ends. (A weak, timing-late
    // hit that instead arrives during the halt is jitter-unreliable under the
    // test harness's fixed-timer catch-up; this strong low drive exercises the
    // same exposure-window latch-clear guard deterministically.)
    await pitchThenSwingAtTarget(room, client, post2, 0, -1000);
    for (let i = 0; i < 6 && room.state.runners.size === 0; i += 1) await room.waitForNextSimulationTick();
    expect(room.state.runners.size).toBeGreaterThan(0); // the drive connected
    client.send('runDecision', { go: false }); // halt at post 1

    let halted = false;
    for (let i = 0; i < 300 && room.state.ballLive && !halted; i += 1) {
      await room.waitForNextSimulationTick();
      const r = room.state.runners.get('carl');
      if (r?.atPost === 1 && !r.running) halted = true;
    }
    expect(halted).toBe(true);

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
    expect(room.state.runners.get('carl')?.out).toBe(false);
    if (!room.state.ballLive && room.state.lastOutcome !== '') {
      const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
      expect(res.cause.kind).not.toBe('runOut');
    }
  }, 30000);

  // ---- Catch / throw pipeline (migrated) -----------------------------------

  it('a hit flown straight at the bowler is caught (pre-bounce) → the batter is out', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_CATCH });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    let received: PlayResolution | null = null;
    client.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);

    const res = await waitPlayEnd(room, 120);
    await room.waitForNextSimulationTick();

    expect(res.cause.kind).toBe('caught');
    expect(FIELDING_IDS).toContain((res.cause as Extract<PlayOutcome, { kind: 'caught' }>).by);
    expect(res.outs).toContain('carl'); // caught batter is out
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(res);
  }, 20000);

  it('a gathered ball is thrown to the exposed post for a run-out (full throw pipeline)', async () => {
    let roomRef: TestRoom | null = null;
    const corridorGatherRng = (): number => {
      const b = roomRef?.state.ball;
      return b !== undefined && Math.abs(b.x) < 1 && b.z > 2 ? 0 : 0.999;
    };
    const room = await colyseus.createRoom('match', { rng: corridorGatherRng });
    roomRef = room;
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    let received: PlayResolution | null = null;
    client.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0, -1000);

    const holders = new Set<string>();
    for (let i = 0; i < 180 && room.state.phase === 'PLAY'; i += 1) {
      await room.waitForNextSimulationTick();
      for (const f of room.state.fielders.values()) {
        if (f.hasBall) holders.add(f.id);
      }
    }
    const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
    await room.waitForNextSimulationTick();

    expect([...holders]).toEqual(['kian']);
    expect(res.cause).toEqual({ kind: 'runOut', atPost: 1, runnerId: 'carl' });
    expect(res.outs).toContain('carl');
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(res);
  }, 20000);

  // ---- Rejection matrix (structured broadcast) -----------------------------

  it('rejects every message out of its phase, broadcasting a structured { message, phase, reason }', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    await awaitClientState(client);
    const rejects: { message: string; phase: MatchPhase; reason: string }[] = [];
    client.onMessage('rejected', (p: { message: string; phase: MatchPhase; reason: string }) => rejects.push(p));

    async function expectReject(send: () => void, message: string, phase: MatchPhase): Promise<void> {
      const before = rejects.length;
      send();
      for (let i = 0; i < 30 && rejects.length === before; i += 1) await room.waitForNextSimulationTick();
      expect(rejects.length).toBeGreaterThan(before);
      const r = rejects[rejects.length - 1];
      expect(r?.message).toBe(message);
      expect(r?.phase).toBe(phase);
      expect(typeof r?.reason).toBe('string');
      expect(r?.reason.length).toBeGreaterThan(0);
    }

    await waitForPhase(room, 'INITIAL_POSITIONING');
    // In INITIAL_POSITIONING: pitch/swing/runDecision/readyForPlay/rematch all illegal.
    await expectReject(() => client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 }), 'pitch', 'INITIAL_POSITIONING');
    await expectReject(() => client.send('readyForPlay'), 'readyForPlay', 'INITIAL_POSITIONING');
    await expectReject(() => client.send('rematch'), 'rematch', 'INITIAL_POSITIONING');

    client.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
    // In PRE_PLAY: pitch/swing/confirmPositioning illegal.
    await expectReject(() => client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 }), 'pitch', 'PRE_PLAY');
    await expectReject(() => client.send('confirmPositioning'), 'confirmPositioning', 'PRE_PLAY');

    client.send('readyForPlay');
    await waitForPhase(room, 'PLAY');
    // In PLAY: readyForPlay/confirmPositioning/rematch illegal; payload-less pitch malformed.
    await expectReject(() => client.send('readyForPlay'), 'readyForPlay', 'PLAY');
    await expectReject(() => client.send('rematch'), 'rematch', 'PLAY');
    await expectReject(() => client.send('pitch'), 'pitch', 'PLAY');
  }, 20000);

  // ---- Scoring / outs ------------------------------------------------------

  it('an own-hit runner who reaches post ≥2 banks a half-rounder (scoreHalves +1)', async () => {
    // A full rounder (home, +2 halves, batter re-queues) is unreachable in the
    // room: the placeholder circuit is ~57.75 m and the fastest runner manages
    // ~6.9 m/s, needing ~8.4 s versus PLAY_TIMEOUT_S = 6 s — so no runner can
    // complete a circuit before the ball dies. The +2/re-queue path is covered
    // by RulesModule's unit tests; here we assert the reachable scoring rung, a
    // half-rounder (post ≥ 2 = +1 half), which exercises the same
    // settlePlay → resolvePlay → scoreHalves wiring. See task-5 report / TUNING.
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);

    // A max-elevation (+60°) hard hit up the +z line: the ball hangs high, well
    // over every post (above POST_HEIGHT), and lands far downfield — never near a
    // post at low altitude, so no accidental run-out — while the play runs to the
    // 6 s timeout and Carl (auto-running through the posts) reaches post 2/3.
    await pitchThenSwingAtTarget(room, client, { x: 0, z: 30 }, 0, 1000);
    const res = await waitPlayEnd(room);

    expect(res.cause.kind).not.toBe('runOut');
    expect(res.cause.kind).not.toBe('caught');
    const carl = room.state.runners.get('carl');
    expect(carl?.atPost).toBeGreaterThanOrEqual(2);
    expect(res.scoreDeltaHalves).toBe(1);
    expect(room.state.scoreHalvesA).toBe(1);
    expect(room.state.scoreHalvesB).toBe(0);
    expect(res.outs).toEqual([]);
  }, 25000);

  it('a caught batter increments the batting side outs', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_CATCH });
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);
    await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);
    const res = await waitPlayEnd(room, 120);
    expect(res.cause.kind).toBe('caught');
    expect(room.state.outs).toBe(1);
    expect(res.outs.length).toBe(1);
  }, 20000);

  // ---- Multi-runner --------------------------------------------------------

  it('two runners are visible in the schema after a play where the first parked safe', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const client = await colyseus.connectTo(room);

    // Play 1: Carl halts safe at post 1 and parks there.
    await startPlay(room, client);
    await pitchThenSwing(room, client, { x: 0.5, y: 0.3, z: 1 });
    client.send('runDecision', { go: false });
    for (let i = 0; i < 600 && room.state.ballLive; i += 1) {
      await room.waitForNextSimulationTick();
    }
    expect(room.state.phase).toBe('PRE_PLAY');
    expect(room.state.runners.get('carl')?.atPost).toBe(1);
    const nextBatter = room.state.currentBatterId;
    expect(nextBatter).not.toBe('carl');

    // Play 2: the next batter hits and starts running — now two runners exist.
    await startPlay(room, client);
    await pitchThenSwing(room, client, { x: 0.5, y: 0.3, z: 1 });
    await room.waitForNextSimulationTick();
    expect(room.state.runners.size).toBe(2);
    expect(room.state.runners.get('carl')).toBeDefined();
    expect(room.state.runners.get(nextBatter)).toBeDefined();
    expect(room.state.runners.get(nextBatter)?.running).toBe(true);
  }, 25000);

  // ---- Full game / rematch -------------------------------------------------

  it('plays a full headless game through to GAME_OVER with a winner', async () => {
    // Side A scores once (the opening play: a miss lets Carl bank a half-rounder);
    // every other play is a guaranteed catch (batter out, 0 runs), so A leads 1-0
    // and, after both innings pairs drain their batting queues, the game ends with
    // A the winner (no tie → no tiebreak). This is the slow marquee test.
    let scoringPlay = true;
    const rng = (): number => (scoringPlay ? 0.999 : 0);
    const room = await colyseus.createRoom('match', { rng });
    const client = await colyseus.connectTo(room);
    await awaitClientState(client);

    let plays = 0;
    while (room.state.phase !== 'GAME_OVER' && plays < 60) {
      await startPlay(room, client);
      if (scoringPlay) {
        await pitchThenSwingAtTarget(room, client, { x: 0, z: 30 }, 0, 1000);
      } else {
        await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);
      }
      await waitPlayEnd(room);
      // Flip to guaranteed-catch only AFTER the scoring play fully resolves — the
      // high ball is still airborne through waitPlayEnd, and flipping early would
      // let a fielder catch it and wipe the score.
      scoringPlay = false;
      plays += 1;
    }

    expect(room.state.phase).toBe('GAME_OVER');
    expect(room.state.winner).toBe('A');
    expect(room.state.scoreHalvesA).toBeGreaterThan(room.state.scoreHalvesB);
  }, 120000);

  it('rematch at GAME_OVER resets to INITIAL_POSITIONING with a zeroed score', async () => {
    let scoringPlay = true;
    const rng = (): number => (scoringPlay ? 0.999 : 0);
    const room = await colyseus.createRoom('match', { rng });
    const client = await colyseus.connectTo(room);
    await awaitClientState(client);

    let plays = 0;
    while (room.state.phase !== 'GAME_OVER' && plays < 60) {
      await startPlay(room, client);
      if (scoringPlay) {
        await pitchThenSwingAtTarget(room, client, { x: 0, z: 30 }, 0, 1000);
      } else {
        await pitchThenSwingAtTarget(room, client, FIELD.BOWLING_SQUARE, 0);
      }
      await waitPlayEnd(room);
      scoringPlay = false;
      plays += 1;
    }
    expect(room.state.phase).toBe('GAME_OVER');

    client.send('rematch');
    await waitForPhase(room, 'INITIAL_POSITIONING');
    expect(room.state.phase).toBe('INITIAL_POSITIONING');
    expect(room.state.scoreHalvesA).toBe(0);
    expect(room.state.scoreHalvesB).toBe(0);
    expect(room.state.winner).toBe('');
    expect(room.state.tiebreak).toBe(false);
    expect(room.state.inningsIndex).toBe(0);
    expect(room.state.runners.size).toBe(0);
    expect(room.state.currentBatterId).toBe(OPENER_ID);
  }, 120000);

  it('garbage rng/seed join options cannot break the room (runtime-validated)', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const garbage = { rng: 1, seed: 'not-a-number' } as unknown as Record<string, unknown>;
    const room = await colyseus.createRoom('match', garbage);
    const client = await colyseus.connectTo(room);
    await startPlay(room, client);

    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    for (let i = 0; i < 30; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0) break;
    }
    expect(room.state.ballLive).toBe(true);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);

    await waitNearPlane(room);
    client.send('swing', { timing: 0, aim: { x: 0, y: 0, z: 1 }, spinInput: 0 });
    for (let i = 0; i < 600 && room.state.phase === 'PLAY'; i += 1) {
      await room.waitForNextSimulationTick();
    }
    expect(room.state.phase).not.toBe('PLAY'); // the play resolved cleanly
    const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
    expect(['caught', 'runOut', 'rounder', 'safe']).toContain(res.cause.kind);
    const uncaught = errorSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[MatchRoom] uncaught exception'),
    );
    expect(uncaught).toEqual([]);
  }, 30000);
});
