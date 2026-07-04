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
 * The deterministic table-order draft that draftSquads (below) always produces:
 * alternating picks straight down the CHARACTERS table (A first), picksEach(11)
 * = 5 per side, whale undrafted. Derived from the roster so the lists cannot
 * drift from it: A = even table indices, B = odd.
 * A: carl, laurie, joel, jonty, joe · B: kian, josh, darcy, robbie, ricy.
 */
const TABLE_IDS = CHARACTERS.map((c) => c.id);
const DRAFTED_A = TABLE_IDS.filter((_, i) => i % 2 === 0).slice(0, 5);
const DRAFTED_B = TABLE_IDS.filter((_, i) => i % 2 === 1).slice(0, 5);
/** A's first pick opens the batting (batting order = pick order). */
const OPENER_ID = DRAFTED_A[0] ?? 'carl';

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

/** Poll the room until `cond()` is true, or throw. */
async function waitForCondition(room: TestRoom, cond: () => boolean, maxTicks = 300): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (cond()) return;
    await room.waitForNextSimulationTick();
  }
  throw new Error('condition not reached');
}

/**
 * Deterministic test draft: whichever side is on turn picks the FIRST remaining
 * id, so a fresh room drafts alternating straight down the CHARACTERS table
 * (A: carl, laurie, joel, jonty, joe · B: kian, josh, darcy, robbie, ricy ·
 * whale undrafted — the DRAFTED_A/DRAFTED_B constants above) and a
 * partially-drafted room resumes from wherever it is. No-op unless the room is
 * currently in DRAFT.
 */
async function draftSquads(room: TestRoom, clientA: TestClient, clientB: TestClient): Promise<void> {
  if (room.state.phase !== 'DRAFT') return;
  while (room.state.draftTurn !== '') {
    const picker = room.state.draftTurn === 'A' ? clientA : clientB;
    const before = room.state.squadAIds.length + room.state.squadBIds.length;
    picker.send('draftPick', { id: room.state.draftRemaining[0] ?? '' });
    await waitForCondition(room, () => room.state.squadAIds.length + room.state.squadBIds.length > before);
  }
  await waitForPhase(room, 'INITIAL_POSITIONING');
}

/** The client currently batting / fielding (side A bats first; innings switches flip it). */
function battingClient(room: TestRoom, clientA: TestClient, clientB: TestClient): TestClient {
  return room.state.battingSide === 'A' ? clientA : clientB;
}
function fieldingClient(room: TestRoom, clientA: TestClient, clientB: TestClient): TestClient {
  return room.state.battingSide === 'A' ? clientB : clientA;
}

/**
 * Walk the phase machine to PLAY: run the deterministic draft if the room is
 * resting in DRAFT (M7 — both seats filled leaves the room there), then BOTH
 * clients confirmPositioning (INITIAL_POSITIONING → PRE_PLAY) and BOTH
 * readyForPlay (PRE_PLAY → PLAY). Covers the very first play and the PRE_PLAY
 * entry after a resolved play alike.
 */
async function startPlay(room: TestRoom, clientA: TestClient, clientB: TestClient): Promise<void> {
  if (room.state.phase === 'LOBBY') await waitForPhase(room, 'DRAFT');
  if (room.state.phase === 'DRAFT') await draftSquads(room, clientA, clientB);
  if (room.state.phase === 'INITIAL_POSITIONING') {
    clientA.send('confirmPositioning');
    clientB.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
  }
  if (room.state.phase === 'PRE_PLAY') {
    clientA.send('readyForPlay');
    clientB.send('readyForPlay');
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

/**
 * Pitch straight from the fielding side, poll until the ball nears the batting
 * plane, then swing with the given aim from the batting side. Both senders are
 * resolved per-call (not bound once) so this works across innings switches. Must
 * already be in PLAY.
 */
async function pitchThenSwing(
  room: TestRoom,
  clientA: TestClient,
  clientB: TestClient,
  aim: { x: number; y: number; z: number },
): Promise<void> {
  fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
  await waitNearPlane(room);
  battingClient(room, clientA, clientB).send('swing', { timing: 0, aim, spinInput: 0 });
  await room.waitForNextSimulationTick();
}

/**
 * Pitch (fielding side), then swing (batting side) `lateTicks` after the ball
 * nears the plane, aiming from the ball's predicted one-tick-ahead contact point
 * at `target` (server-authoritative, read synchronously). `aimY` sets the
 * vertical aim (default 0 = flat drive; a large value is clamped by HitModule to
 * +60°, a large negative to −10°). Both senders are resolved per-call (not bound
 * once) so this works across innings switches. Must already be in PLAY.
 */
async function pitchThenSwingAtTarget(
  room: TestRoom,
  clientA: TestClient,
  clientB: TestClient,
  target: { x: number; z: number },
  lateTicks: number,
  aimY = 0,
): Promise<void> {
  fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
  await waitNearPlane(room);
  for (let i = 0; i < lateTicks; i += 1) {
    await room.waitForNextSimulationTick();
  }
  const dt = CONST.PHYSICS.FIXED_TIMESTEP;
  const cx = room.state.ball.x + room.state.ball.vx * dt;
  const cz = room.state.ball.z + room.state.ball.vz * dt;
  battingClient(room, clientA, clientB).send('swing', {
    timing: 0,
    aim: { x: target.x - cx, y: aimY, z: target.z - cz },
    spinInput: 0,
  });
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

  /** Seat two clients (join order fixes sides: first = A, second = B) and await both snapshots. */
  async function connectPair(room: TestRoom): Promise<{ clientA: TestClient; clientB: TestClient }> {
    const clientA = await colyseus.connectTo(room);
    const clientB = await colyseus.connectTo(room);
    await awaitClientState(clientA);
    await awaitClientState(clientB);
    return { clientA, clientB };
  }

  // ---- Boot / lobby --------------------------------------------------------

  it('rests in DRAFT once both clients are seated; the completed draft advances to INITIAL_POSITIONING', async () => {
    const room = await colyseus.createRoom('match', {});
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    expect(room.state.currentPitcherId).toBe(''); // no fielding side until the draft completes
    await draftSquads(room, clientA, clientB);
    expect(room.state.phase).toBe('INITIAL_POSITIONING');
    // The rules view is mirrored into the schema from the first frame.
    expect(room.state.battingSide).toBe('A');
    expect(room.state.currentBatterId).toBe(OPENER_ID);
    expect(room.state.currentPitcherId).toBe('kian');
  });

  it('the drafted five field at the first FIELDING_POSITIONS slots (default pitcher on the bowler slot)', async () => {
    const room = await colyseus.createRoom('match', {});
    expect(room.state.fielders.size).toBe(0); // no fielders until the draft completes
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    expect(room.state.fielders.size).toBe(5);
    // kian (B's default pitcher — best pitch stat, tie to the earlier pick) takes
    // slot 0, the bowling square; the rest follow in pick order on slots 1–4.
    const onField = ['kian', ...DRAFTED_B.filter((id) => id !== 'kian')];
    onField.forEach((id, i) => {
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
    const { clientA, clientB } = await connectPair(room);

    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    await waitForPhase(room, 'INITIAL_POSITIONING');
    clientA.send('confirmPositioning');
    clientB.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
    expect(room.state.phase).toBe('PRE_PLAY');
    clientA.send('readyForPlay');
    clientB.send('readyForPlay');
    await waitForPhase(room, 'PLAY');
    expect(room.state.phase).toBe('PLAY');

    // Drive a caught out → resolves back to PRE_PLAY with outs incremented.
    await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
    const res = await waitPlayEnd(room);
    expect(room.state.phase).toBe('PRE_PLAY');
    expect(res.cause.kind).toBe('caught');
    expect(room.state.outs).toBe(1);
    expect(room.state.currentBatterId).not.toBe(OPENER_ID); // batter rotated on
  });

  // ---- Pitch / swing basics (migrated onto the phase machine) --------------

  it('pitch while in PLAY makes the ball live with stat-derived speed', async () => {
    const room = await colyseus.createRoom('match', {});
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    const before = { vx: room.state.ball.vx, vz: room.state.ball.vz };
    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 1, y: 0, z: 0 }, spinInput: 1 });
    await room.waitForNextSimulationTick();
    expect(room.state.ball.vz).toBeLessThan(0);
    expect(Math.sign(room.state.ball.vx)).toBe(Math.sign(before.vx));
    expect(room.state.lastRejection).toContain('pitch');
  });

  it('rejects a swing when no ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    battingClient(room, clientA, clientB).send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.lastRejection).toContain('swing');
  });

  it('rejects a pitch message sent with no payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    fieldingClient(room, clientA, clientB).send('pitch');
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.lastRejection).toContain('pitch');
  });

  it('rejects a swing message sent with a null payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    battingClient(room, clientA, clientB).send('swing', null);
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.lastRejection).toContain('swing');
  });

  it('stays responsive to a valid pitch after payload-less pitch/swing messages', async () => {
    const room = await colyseus.createRoom('match', {});
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    fieldingClient(room, clientA, clientB).send('pitch');
    await room.waitForNextSimulationTick();
    battingClient(room, clientA, clientB).send('swing', null);
    await room.waitForNextSimulationTick();
    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await waitNearPlane(room);
    battingClient(room, clientA, clientB).send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await room.waitForNextSimulationTick();
    expect(room.state.ball.vz).toBeGreaterThan(0);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(10);
  }, 15000);

  // ---- Running -------------------------------------------------------------

  it('a connected hit starts a runner heading towards post 1', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    await pitchThenSwing(room, clientA, clientB, { x: 0.5, y: 0.3, z: 1 });
    await room.waitForNextSimulationTick();
    const runner = room.state.runners.get('carl');
    expect(runner).toBeDefined();
    expect(runner?.running).toBe(true);
    expect(runner?.atPost).toBe(-1);
    expect(runner?.out).toBe(false);
  });

  it('runDecision {go:false} halts the runner at post 1, and the play ends safe there', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    await pitchThenSwing(room, clientA, clientB, { x: 0.5, y: 0.3, z: 1 });
    battingClient(room, clientA, clientB).send('runDecision', { go: false });

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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    const batter = battingClient(room, clientA, clientB);

    batter.send('runDecision', { go: true });
    await room.waitForNextSimulationTick();
    expect(room.state.lastRejection).toContain('runDecision');

    batter.send('runDecision', { go: 'yes' });
    await room.waitForNextSimulationTick();
    expect(room.state.lastRejection).toContain('runDecision');

    batter.send('runDecision');
    await room.waitForNextSimulationTick();
    expect(room.state.lastRejection).toContain('runDecision');
    expect(room.state.ballLive).toBe(false);
  });

  // ---- Run-out detection (migrated) ----------------------------------------

  it('a hit flown directly at an exposed post is a run-out (event-accurate sensor)', async () => {
    const post1 = FIELD.POSTS[0];
    if (post1 === undefined) throw new Error('no post 1 in fixture');

    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, clientA, clientB, post1, 0);

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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);

    await pitchThenSwingAtTarget(room, clientA, clientB, post2, 0);
    battingClient(room, clientA, clientB).send('runDecision', { go: false }); // halt at post 1

    let haltedAtPost1 = false;
    for (let i = 0; i < 240 && room.state.ballLive && !haltedAtPost1; i += 1) {
      await room.waitForNextSimulationTick();
      const r = room.state.runners.get('carl');
      if (r?.atPost === 1 && !r.running) haltedAtPost1 = true;
    }
    expect(haltedAtPost1).toBe(true);
    expect(room.state.ballLive).toBe(true);

    battingClient(room, clientA, clientB).send('runDecision', { go: true }); // resume towards post 2 — the stale-latch moment
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);

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
    await pitchThenSwingAtTarget(room, clientA, clientB, post2, 0, -1000);
    for (let i = 0; i < 6 && room.state.runners.size === 0; i += 1) await room.waitForNextSimulationTick();
    expect(room.state.runners.size).toBeGreaterThan(0); // the drive connected
    battingClient(room, clientA, clientB).send('runDecision', { go: false }); // halt at post 1

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
      battingClient(room, clientA, clientB).send('runDecision', { go: true }); // exposure flips null → 2 between ticks
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);

    const res = await waitPlayEnd(room, 120);
    await room.waitForNextSimulationTick();

    expect(res.cause.kind).toBe('caught');
    expect(DRAFTED_B).toContain((res.cause as Extract<PlayOutcome, { kind: 'caught' }>).by);
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0, -1000);

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
    const { clientA, clientB } = await connectPair(room);
    // Rejections are targeted (client.send), not broadcast — each collector
    // must listen on the SAME client that sends the offending message.
    const rejects: { message: string; phase: MatchPhase; reason: string }[] = [];
    const rejectsB: { message: string; phase: MatchPhase; reason: string }[] = [];
    clientA.onMessage('rejected', (p: { message: string; phase: MatchPhase; reason: string }) => rejects.push(p));
    clientB.onMessage('rejected', (p: { message: string; phase: MatchPhase; reason: string }) => rejectsB.push(p));

    async function expectReject(
      send: () => void,
      message: string,
      phase: MatchPhase,
      collector: { message: string; phase: MatchPhase; reason: string }[] = rejects,
    ): Promise<void> {
      const before = collector.length;
      send();
      for (let i = 0; i < 30 && collector.length === before; i += 1) await room.waitForNextSimulationTick();
      expect(collector.length).toBeGreaterThan(before);
      const r = collector[collector.length - 1];
      expect(r?.message).toBe(message);
      expect(r?.phase).toBe(phase);
      expect(typeof r?.reason).toBe('string');
      expect(r?.reason.length).toBeGreaterThan(0);
    }

    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    await waitForPhase(room, 'INITIAL_POSITIONING');
    // In INITIAL_POSITIONING: pitch/swing/runDecision/readyForPlay/rematch/draftPick
    // all illegal (phase check runs before the role check, so the out-of-phase
    // reason wins regardless of which client sends).
    await expectReject(() => clientA.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 }), 'pitch', 'INITIAL_POSITIONING');
    await expectReject(() => clientA.send('readyForPlay'), 'readyForPlay', 'INITIAL_POSITIONING');
    await expectReject(() => clientA.send('rematch'), 'rematch', 'INITIAL_POSITIONING');
    await expectReject(() => clientA.send('draftPick', { id: 'whale' }), 'draftPick', 'INITIAL_POSITIONING');

    clientA.send('confirmPositioning');
    clientB.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
    // In PRE_PLAY: pitch/swing/confirmPositioning illegal.
    await expectReject(() => clientA.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 }), 'pitch', 'PRE_PLAY');
    await expectReject(() => clientA.send('confirmPositioning'), 'confirmPositioning', 'PRE_PLAY');

    clientA.send('readyForPlay');
    clientB.send('readyForPlay');
    await waitForPhase(room, 'PLAY');
    // In PLAY: readyForPlay/confirmPositioning/rematch/setPitcher illegal; a
    // payload-less pitch from the FIELDING side (clientB — side A bats first)
    // is malformed, not wrongRole.
    await expectReject(() => clientA.send('readyForPlay'), 'readyForPlay', 'PLAY');
    await expectReject(() => clientA.send('rematch'), 'rematch', 'PLAY');
    await expectReject(() => fieldingClient(room, clientA, clientB).send('setPitcher', { id: 'kian' }), 'setPitcher', 'PLAY', rejectsB);
    await expectReject(() => fieldingClient(room, clientA, clientB).send('pitch'), 'pitch', 'PLAY', rejectsB);
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);

    // A max-elevation (+60°) hard hit up the +z line: the ball hangs high, well
    // over every post (above POST_HEIGHT), and lands far downfield — never near a
    // post at low altitude, so no accidental run-out — while the play runs to the
    // 6 s timeout and Carl (auto-running through the posts) reaches post 2/3.
    await pitchThenSwingAtTarget(room, clientA, clientB, { x: 0, z: 30 }, 0, 1000);
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
    const res = await waitPlayEnd(room, 120);
    expect(res.cause.kind).toBe('caught');
    expect(room.state.outs).toBe(1);
    expect(res.outs.length).toBe(1);
  }, 20000);

  // ---- Multi-runner --------------------------------------------------------

  it('two runners are visible in the schema after a play where the first parked safe', async () => {
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);

    // Play 1: Carl halts safe at post 1 and parks there.
    await startPlay(room, clientA, clientB);
    await pitchThenSwing(room, clientA, clientB, { x: 0.5, y: 0.3, z: 1 });
    battingClient(room, clientA, clientB).send('runDecision', { go: false });
    for (let i = 0; i < 600 && room.state.ballLive; i += 1) {
      await room.waitForNextSimulationTick();
    }
    expect(room.state.phase).toBe('PRE_PLAY');
    expect(room.state.runners.get('carl')?.atPost).toBe(1);
    const nextBatter = room.state.currentBatterId;
    expect(nextBatter).not.toBe('carl');

    // Play 2: the next batter hits and starts running — now two runners exist.
    await startPlay(room, clientA, clientB);
    await pitchThenSwing(room, clientA, clientB, { x: 0.5, y: 0.3, z: 1 });
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
    const { clientA, clientB } = await connectPair(room);

    let plays = 0;
    while (room.state.phase !== 'GAME_OVER' && plays < 60) {
      await startPlay(room, clientA, clientB);
      if (scoringPlay) {
        await pitchThenSwingAtTarget(room, clientA, clientB, { x: 0, z: 30 }, 0, 1000);
      } else {
        await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
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
    const { clientA, clientB } = await connectPair(room);

    let plays = 0;
    while (room.state.phase !== 'GAME_OVER' && plays < 60) {
      await startPlay(room, clientA, clientB);
      if (scoringPlay) {
        await pitchThenSwingAtTarget(room, clientA, clientB, { x: 0, z: 30 }, 0, 1000);
      } else {
        await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
      }
      await waitPlayEnd(room);
      scoringPlay = false;
      plays += 1;
    }
    expect(room.state.phase).toBe('GAME_OVER');

    clientA.send('rematch');
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
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);

    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    for (let i = 0; i < 30; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0) break;
    }
    expect(room.state.ballLive).toBe(true);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);

    await waitNearPlane(room);
    battingClient(room, clientA, clientB).send('swing', { timing: 0, aim: { x: 0, y: 0, z: 1 }, spinInput: 0 });
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

  // ---- M7: draft & setPitcher ------------------------------------------------

  describe('M7 draft', () => {
    it('rests in DRAFT after both join, alternates picks A first, and completes to INITIAL_POSITIONING', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      expect(room.state.draftTurn).toBe('A');
      expect(room.state.draftRemaining.length).toBe(CHARACTERS.length);
      // Out of turn: B may not open the draft.
      clientB.send('draftPick', { id: 'kian' });
      await waitForCondition(room, () => room.state.lastRejection !== '');
      expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
      await draftSquads(room, clientA, clientB);
      expect([...room.state.squadAIds]).toEqual(['carl', 'laurie', 'joel', 'jonty', 'joe']);
      expect([...room.state.squadBIds]).toEqual(['kian', 'josh', 'darcy', 'robbie', 'ricy']);
      expect([...room.state.draftRemaining]).toEqual(['whale']);
      expect(room.state.draftTurn).toBe('');
      expect(room.state.currentPitcherId).toBe('kian'); // B fields first; highest pitch, tie → earlier pick
      expect(room.state.fielders.size).toBe(5); // the drafted five, not the M5 mirror nine
    });

    it('rejects a taken pick, then resumes cleanly; picks outside DRAFT are rejected', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      clientA.send('draftPick', { id: 'carl' });
      await waitForCondition(room, () => room.state.squadAIds.length === 1);
      clientB.send('draftPick', { id: 'carl' }); // taken
      await waitForCondition(room, () => room.state.lastRejection.includes('draftPick'));
      expect(JSON.parse(room.state.lastRejection).reason).not.toBe('wrongRole'); // prose reason, right role
      expect(room.state.draftTurn).toBe('B'); // a failed pick does not burn the turn
      await draftSquads(room, clientA, clientB); // resumes from the partial state
      expect(room.state.phase).toBe('INITIAL_POSITIONING');
      expect([...room.state.squadAIds]).toEqual(['carl', 'laurie', 'joel', 'jonty', 'joe']);
      expect([...room.state.squadBIds]).toEqual(['kian', 'josh', 'darcy', 'robbie', 'ricy']);
      clientA.send('draftPick', { id: 'whale' }); // outside DRAFT
      await waitForCondition(room, () => room.state.lastRejection.includes('only allowed in DRAFT'));
    });

    it('setPitcher: fielding side re-slots its bowler; batting side and PLAY-phase attempts rejected', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      // A bats first, so B is the fielding side in INITIAL_POSITIONING.
      clientA.send('setPitcher', { id: 'joel' });
      await waitForCondition(room, () => room.state.lastRejection.includes('setPitcher'));
      expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
      clientB.send('setPitcher', { id: 'ricy' });
      await waitForCondition(room, () => room.state.currentPitcherId === 'ricy');
      const ricy = room.state.fielders.get('ricy');
      expect(ricy?.x).toBe(FIELD.FIELDING_POSITIONS[0]?.x); // nominee took the bowling square
      expect(ricy?.z).toBe(FIELD.FIELDING_POSITIONS[0]?.z);
      clientB.send('setPitcher', { id: 'carl' }); // not in B's squad
      await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason !== 'wrongRole');
      expect(JSON.parse(room.state.lastRejection).reason).toBe('not in your squad');
      await startPlay(room, clientA, clientB);
      clientB.send('setPitcher', { id: 'kian' }); // positions locked in PLAY
      await waitForCondition(room, () => room.state.lastRejection.includes('only allowed'));
      expect(room.state.currentPitcherId).toBe('ricy');
    }, 20000);

    it('after an innings switch the OTHER five field with THEIR default pitcher', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_CATCH });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      // ALWAYS_CATCH + a flat drive straight at the bowler: caught pre-bounce
      // every play (the same deterministic idiom as the caught-out tests — a
      // LOFTED midfield hit would instead land in the now-unmanned deep field,
      // be gathered post-bounce, and park batters safe indefinitely), so A's
      // 5-batter queue drains in 5 outs and battingSide flips to 'B'.
      let plays = 0;
      while (room.state.battingSide === 'A' && room.state.phase !== 'GAME_OVER' && plays < 8) {
        await startPlay(room, clientA, clientB);
        await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
        await waitForCondition(room, () => room.state.phase !== 'PLAY', 800);
        plays += 1;
      }
      expect(plays).toBe(5); // one caught batter per play, no re-queues
      expect(room.state.battingSide).toBe('B');
      expect(room.state.currentPitcherId).toBe('joel'); // A fields now; joel has A's best arm (pitch 9)
      expect(room.state.fielders.size).toBe(5);
      expect([...room.state.fielders.keys()].sort()).toEqual(['carl', 'joe', 'joel', 'jonty', 'laurie']);
    }, 60000);
  });

  // ---- M6: role gating -------------------------------------------------------

  describe('M6 role gating', () => {
    it('rejects a pitch from the batting side and accepts it from the fielding side', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      // Side A bats first (battingSide 'A' at match start) → A may NOT pitch.
      clientA.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
      await room.waitForNextSimulationTick();
      expect(room.state.ballLive).toBe(false);
      expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
      clientB.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
      await room.waitForNextSimulationTick();
      expect(room.state.ballLive).toBe(true);
    });

    it('rejects swing and runDecision from the fielding side', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      clientB.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
      await waitNearPlane(room);
      clientB.send('swing', { timing: 0, aim: { x: 0.55, y: 0.47, z: 0.65 }, spinInput: 0 });
      await room.waitForNextSimulationTick();
      expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
      clientB.send('runDecision', { go: false });
      await room.waitForNextSimulationTick();
      expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
    });

    it('delivers a rejected message ONLY to the offending client, never broadcasting it to the other', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      const rejectsA: unknown[] = [];
      const rejectsB: unknown[] = [];
      clientA.onMessage('rejected', (p: unknown) => rejectsA.push(p));
      clientB.onMessage('rejected', (p: unknown) => rejectsB.push(p));

      // Side A bats first, so A pitching is a routine wrongRole rejection.
      clientA.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
      for (let i = 0; i < 10; i += 1) await room.waitForNextSimulationTick();

      expect(rejectsA.length).toBe(1);
      expect(rejectsB.length).toBe(0); // B must NEVER see A's own rejection
    });

    it('requires BOTH sides to confirm positioning and ready up (duplicates idempotent)', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      await waitForPhase(room, 'INITIAL_POSITIONING');
      clientA.send('confirmPositioning');
      clientA.send('confirmPositioning'); // duplicate: accepted, no transition, no rejection
      for (let i = 0; i < 10; i += 1) await room.waitForNextSimulationTick();
      expect(room.state.phase).toBe('INITIAL_POSITIONING');
      expect(room.state.lastRejection).toBe('');
      clientB.send('confirmPositioning');
      await waitForPhase(room, 'PRE_PLAY');
      clientB.send('readyForPlay');
      for (let i = 0; i < 10; i += 1) await room.waitForNextSimulationTick();
      expect(room.state.phase).toBe('PRE_PLAY');
      clientA.send('readyForPlay');
      await waitForPhase(room, 'PLAY');
    });
  });

  // ---- M6: seats, room code, real lobby wait -------------------------------

  describe('M6 lobby & seats', () => {
    it('holds in LOBBY with one client, advances on the second, seats by join order', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const clientA = await colyseus.connectTo(room);
      await awaitClientState(clientA);
      for (let i = 0; i < 30; i += 1) await room.waitForNextSimulationTick();
      expect(room.state.phase).toBe('LOBBY'); // no fast-forward on first join any more
      expect(room.state.sessionA).toBe(clientA.sessionId);
      expect(room.state.sessionB).toBe('');

      const clientB = await colyseus.connectTo(room);
      await awaitClientState(clientB);
      await waitForPhase(room, 'DRAFT'); // M7: the second seat opens the draft, not positioning
      expect(room.state.sessionB).toBe(clientB.sessionId);
      expect(room.state.connectedA).toBe(true);
      expect(room.state.connectedB).toBe(true);
    });

    it('matches a filtered join to the room with that code, and rejects a wrong code', async () => {
      const created = await colyseus.sdk.create<MatchState>('match', { code: 'ABCD' });
      const joined = await colyseus.sdk.join<MatchState>('match', { code: 'ABCD' });
      expect(joined.roomId).toBe(created.roomId);
      await expect(colyseus.sdk.join('match', { code: 'ZZZZ' })).rejects.toThrow();
      await created.leave();
      await joined.leave();
    });

    it('mirrors a valid creation code into state and rejects a malformed one', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { code: 'GXQT' });
      expect(room.state.roomCode).toBe('GXQT');
      await expect(colyseus.createRoom('match', { code: 'nope!' })).rejects.toThrow();
    });

    it('locks the room at two clients', async () => {
      const room = await colyseus.createRoom<MatchState>('match', {});
      await connectPair(room);
      await expect(colyseus.connectTo(room)).rejects.toThrow();
    });
  });

  describe('M6 disconnect handling', () => {
    it('an unconsented drop pauses the game (ball frozen) and a reconnect resumes it', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
      await waitNearPlane(room); // ball demonstrably in flight
      const token = clientB.reconnectionToken;
      await clientB.leave(false); // unconsented
      await waitForCondition(room, () => room.state.paused);
      const frozen = { x: room.state.ball.x, z: room.state.ball.z };
      for (let i = 0; i < 30; i += 1) await room.waitForNextSimulationTick();
      expect(room.state.ball.x).toBe(frozen.x);
      expect(room.state.ball.z).toBe(frozen.z);
      // Gameplay is rejected while paused.
      clientA.send('swing', { timing: 0, aim: { x: 0.55, y: 0.47, z: 0.65 }, spinInput: 0 });
      await room.waitForNextSimulationTick();
      expect(JSON.parse(room.state.lastRejection).reason).toBe('paused');
      const rejoined = await colyseus.sdk.reconnect(token);
      await waitForCondition(room, () => !room.state.paused);
      expect(room.state.connectedB).toBe(true);
      await rejoined.leave();
    });

    it('a consented mid-game leave notifies the survivor and disposes the room', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      const left = new Promise<{ side: string }>((resolve) => {
        clientA.onMessage('opponentLeft', (m: { side: string }) => resolve(m));
      });
      await clientB.leave(true); // deliberate quit
      expect((await left).side).toBe('B');
    });

    it('grace expiry disposes the room (short test-only grace)', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS, reconnectGraceS: 1 });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      const left = new Promise<{ side: string }>((resolve) => {
        clientA.onMessage('opponentLeft', (m: { side: string }) => resolve(m));
      });
      await clientB.leave(false);
      expect((await left).side).toBe('B'); // fires when the 1 s grace lapses
    }, 10000);

    it('rejects a third client trying to join while a reconnect grace is pending', async () => {
      // Pins the Colyseus seat-reservation invariant that guards the room while
      // it is unlocked mid-grace: an unconsented drop frees no seat count-wise
      // (allowReconnection reserves the slot), so a third join must still fail
      // exactly like the steady-state two-client lock, even though one seat's
      // socket is currently disconnected.
      const clientA = await colyseus.sdk.create<MatchState>('match', { code: 'GRAC', rng: ALWAYS_MISS });
      const clientB = await colyseus.sdk.join<MatchState>('match', { code: 'GRAC' });
      await awaitClientState(clientA);
      await awaitClientState(clientB);
      const room = colyseus.getRoomById<MatchState>(clientA.roomId);
      await startPlay(room, clientA, clientB);
      await clientB.leave(false); // unconsented: seat held for the grace window
      await waitForCondition(room, () => room.state.paused);

      await expect(colyseus.sdk.join('match', { code: 'GRAC' })).rejects.toThrow();
    });

    it('a consented quit broadcasts exactly ONE opponentLeft, never a spurious second one for the survivor', async () => {
      // Regression for the onLeave re-entrancy bug: this.disconnect() forcibly
      // closes every remaining client, which RE-INVOKES the survivor's own
      // onLeave. Pre-fix, sideOf still resolved and phase wasn't LOBBY, so the
      // consented branch ran a SECOND time for the survivor and broadcast a
      // second opponentLeft naming the WRONG side (the survivor's own side, 'A',
      // instead of the real leaver's side, 'B').
      //
      // A naive client-side message collector is NOT sufficient here: the
      // server-side broadcast() for the re-entrant call races the survivor's own
      // forced connection close (disconnect() closes the survivor's socket
      // right after broadcasting), so the second message is frequently dropped
      // in-flight rather than delivered — the client sees only one message even
      // though the room broadcast twice. So this test spies directly on
      // `Room.prototype.broadcast` (server-side, unaffected by delivery/close
      // races) to see how many times 'opponentLeft' actually fired, IN ADDITION
      // to the client-side collector.
      const { Room } = await import('@colyseus/core');
      const broadcastSpy = vi.spyOn(Room.prototype, 'broadcast');

      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);

      const received: { side: string }[] = [];
      clientA.onMessage('opponentLeft', (m: { side: string }) => received.push(m));

      await clientB.leave(true); // deliberate quit

      // Wait for disposal to settle: poll clientA's connection until it closes,
      // capped so a genuine hang still fails fast instead of timing out silently.
      const deadline = Date.now() + 2000;
      while (clientA.connection.isOpen && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Let any queued microtasks/timers (e.g. the re-entrant onLeave's own
      // broadcast + disconnect chain) settle before reading the spy.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const opponentLeftCalls = broadcastSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0] === 'opponentLeft');
      expect(opponentLeftCalls.length).toBe(1);
      expect(opponentLeftCalls[0]?.[1]).toEqual({ side: 'B' });
      expect(received).toEqual([{ side: 'B' }]);
    }, 10000);
  });

  // ---- M8: positioning, substitutions, batter choice, stamina ledger --------

  describe('M8 positioning', () => {
    it('fielding side repositions a fielder; the schema fielder moves and survives into PLAY', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      clientB.send('reposition', { id: 'josh', x: 5, z: 20 });
      await waitForCondition(room, () => room.state.fielders.get('josh')?.x === 5);
      expect(room.state.fielders.get('josh')?.z).toBe(20);
      await startPlay(room, clientA, clientB);
      expect(room.state.fielders.get('josh')?.x).toBe(5); // layout survived PRE_PLAY → PLAY
      clientB.send('reposition', { id: 'josh', x: 6, z: 20 }); // locked in PLAY
      await waitForCondition(room, () => room.state.lastRejection.includes('reposition'));
      expect(room.state.fielders.get('josh')?.x).toBe(5);
    }, 20000);

    it('rejects: batting side (wrongRole), the pitcher, out-of-zone and keep-out spots', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      clientA.send('reposition', { id: 'joel', x: 5, z: 20 });
      await waitForCondition(room, () => room.state.lastRejection.includes('reposition'));
      expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
      clientB.send('reposition', { id: 'kian', x: 5, z: 20 }); // the pitcher — nominate, don't drag
      await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason.includes('pitcher'));
      clientB.send('reposition', { id: 'josh', x: 999, z: 20 });
      await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason.includes('illegal'));
      // Clear the mirror so the NEXT illegal-spot rejection is provably fresh —
      // the previous reason also said 'illegal', so a bare includes() would pass
      // vacuously without the server ever rejecting the keep-out spot.
      room.state.lastRejection = '';
      clientB.send('reposition', { id: 'josh', x: 1, z: 1 }); // inside the batting-square keep-out
      await waitForCondition(room, () => JSON.parse(room.state.lastRejection || '{"reason":""}').reason.includes('illegal'));
      // Nothing moved: josh still sits on his default slot.
      expect(room.state.fielders.get('josh')?.x).toBe(FIELD.FIELDING_POSITIONS[1]?.x);
    }, 20000);

    it('layout persists across an innings switch and returns intact next innings', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_CATCH });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      clientB.send('reposition', { id: 'josh', x: 5, z: 20 });
      await waitForCondition(room, () => room.state.fielders.get('josh')?.x === 5);
      // Bat out side A, then side B — back to A batting, B fielding. Uses the
      // deterministic caught-at-the-bowler idiom of the M7 innings-switch test
      // (ALWAYS_CATCH + flat drive at the bowling square = one out per play);
      // the brief's flat midfield drive lands post-bounce (gathered, no out)
      // and would never drain the queue.
      let plays = 0;
      while (room.state.battingSide === 'A' && room.state.phase !== 'GAME_OVER' && plays < 8) {
        await startPlay(room, clientA, clientB);
        await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
        await waitForCondition(room, () => room.state.phase !== 'PLAY', 800);
        plays += 1;
      }
      expect(room.state.battingSide).toBe('B');
      expect(room.state.fielders.get('joel')).toBeDefined(); // A's five field now
      plays = 0;
      while (room.state.battingSide === 'B' && room.state.phase !== 'GAME_OVER' && plays < 8) {
        await startPlay(room, clientA, clientB);
        await pitchThenSwingAtTarget(room, clientA, clientB, FIELD.BOWLING_SQUARE, 0);
        await waitForCondition(room, () => room.state.phase !== 'PLAY', 800);
        plays += 1;
      }
      if (room.state.phase !== 'GAME_OVER') {
        expect(room.state.fielders.get('josh')?.x).toBe(5); // B's custom layout came back
        expect(room.state.fielders.get('josh')?.z).toBe(20);
      }
    }, 120000);

    it('substitute works with a real bench (fieldSlotsOverride) and syncs bench/count', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS, fieldSlotsOverride: 3 });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      expect([...room.state.benchB]).toEqual(['robbie', 'ricy']); // B's picks 4-5 benched at 3 slots
      expect(room.state.fielders.size).toBe(3);
      clientB.send('substitute', { outId: 'josh', inId: 'ricy' });
      await waitForCondition(room, () => room.state.subsUsedB === 1);
      expect(room.state.fielders.get('ricy')).toBeDefined();
      expect(room.state.fielders.get('josh')).toBeUndefined();
      expect([...room.state.benchB]).toContain('josh');
      clientA.send('substitute', { outId: 'joel', inId: 'joe' }); // batting side
      await waitForCondition(
        room,
        () => room.state.lastRejection !== '' && JSON.parse(room.state.lastRejection).reason === 'wrongRole',
      );
    }, 20000);

    it('setBatter: batting side picks any queued batter; fielding side rejected', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      expect(room.state.currentBatterId).toBe('carl');
      expect([...room.state.queueIds]).toEqual(['laurie', 'joel', 'jonty', 'joe']);
      clientB.send('setBatter', { id: 'joe' });
      await waitForCondition(
        room,
        () => room.state.lastRejection !== '' && JSON.parse(room.state.lastRejection).reason === 'wrongRole',
      );
      clientA.send('setBatter', { id: 'joe' });
      await waitForCondition(room, () => room.state.currentBatterId === 'joe');
      expect([...room.state.queueIds]).toEqual(['carl', 'laurie', 'joel', 'jonty']);
    }, 20000);

    it('stamina persists across plays and the benched regain (ledger)', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS, fieldSlotsOverride: 3 });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      await startPlay(room, clientA, clientB);
      await pitchThenSwing(room, clientA, clientB, { x: 0.55, y: 0.47, z: 0.65 });
      await waitForCondition(room, () => room.state.phase !== 'PLAY', 800);
      // A chaser sprinted last play: SOME on-field fielder is below stat stamina next play.
      const drained = [...room.state.fielders.values()].some(
        (f) => f.stamina < (CHARACTERS.find((c) => c.id === f.id)?.stats.stamina ?? 0),
      );
      expect(drained).toBe(true);
    }, 30000);
  });
});
