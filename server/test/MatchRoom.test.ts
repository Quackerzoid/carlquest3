import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, ColyseusTestServer } from '@colyseus/testing';
import type { Room } from '@colyseus/core';
import type { Room as ClientRoom } from 'colyseus.js';
import {
  CHARACTERS,
  CONST,
  exitVelocity,
  getCharacter,
  pressureMult,
  timingFactor,
  type MatchPhase,
  type PlayOutcome,
  type PlayResolution,
  type RollEvent,
} from '@carlquest/shared';
import appConfig from '../src/app.config';
import { MatchState } from '../src/rooms/MatchState';

/** Server-side room handle as returned by `colyseus.createRoom<MatchState>(...)`. */
type TestRoom = Room<MatchState>;
/** Client-side room handle as returned by `colyseus.connectTo<MatchState>(...)`. */
type TestClient = ClientRoom<MatchState>;

const { FIELD, GAME, PHYSICS } = CONST;

/**
 * Tick budgets (2026-07-05 readable-game overhaul): the room ticks at 60 Hz
 * REAL time and sim time advances by the real dt, so N sim-seconds cost about
 * 60·N waitForNextSimulationTick calls. Budgets DERIVE from the pacing
 * constants (never hardcoded tick counts) and carry 2× headroom for
 * event-loop load — waits exit early on success, so generosity is free.
 */
const ticksFor = (simSeconds: number): number => Math.ceil(simSeconds * 60 * 2);
/**
 * Worst-case sim length of ONE play: up to this many no-contact loops (pitch
 * delay + ~2 s of flight + the fast miss-respawn) before a swing connects,
 * then a full post-contact flight to the PLAY_TIMEOUT_S settle, then the
 * outcome hold. Seeded plays connect far sooner; this is the failure bound.
 */
const MAX_REPITCH_LOOPS = 8;
const PLAY_SIM_BUDGET_S =
  (GAME.AUTOPLAY_PITCH_DELAY_S + GAME.MISS_RESPAWN_S + 2) * MAX_REPITCH_LOOPS +
  GAME.PLAY_TIMEOUT_S +
  GAME.OUTCOME_HOLD_S +
  2;
const PLAY_TICK_BUDGET = ticksFor(PLAY_SIM_BUDGET_S);

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

/**
 * rng() that always misses every real roster's pCatch. Under the auto-play
 * redesign this rng ALSO drives the AutoPlayModule, where 0.999 samples a
 * swing timing error of (0.999·2−1)·0.3 ≈ +0.2994 s — outside every batter's
 * window (max timingWindow = 0.25 s) — so an ALWAYS_MISS room NEVER makes bat
 * contact: each play sits in the deterministic no-contact re-pitch loop and
 * the room stays in PLAY indefinitely. Tests use it exactly for that: a
 * stable, side-effect-free PLAY state (positioning locks, pause/disconnect,
 * rejection matrices). ALWAYS_CATCH (0) is GONE: rng 0 samples timing error
 * −0.3 s, also a guaranteed miss, so it can no longer produce catches —
 * outcome-specific tests pin seeds instead (see the SEED_* constants).
 */
const ALWAYS_MISS = (): number => 0.999;

/**
 * Pinned seeds for outcome-specific auto-play tests (M4/M5 precedent for
 * legitimate seed selection): RE-DERIVED for the 2026-07-05 readable-game
 * overhaul (the loft draw shifted the shared rng stream and the ×2 field
 * changed flight/run ratios) by a bounded sweep of seeds 1–8 with the Task-2
 * scratch harness (two test clients, deterministic table-order draft, the
 * first four plays of each seed driven purely by the room's own beats — all
 * outcome classes appeared well inside the ≤30-seed bound). Each constant
 * names the behaviour its seed exhibited so a formula or roster change that
 * invalidates one fails loudly here, not flakily elsewhere.
 */
/** Seed 2, play 1: carl connects on the first pitch and parks safe at post 3 (+1 half). */
const SEED_FIRST_PLAY_CONTACT = 2;
const SEED_FIRST_PLAY_SAFE = 2;
const SEED_HALF_ROUNDER = 2;
/** Seed 2 again: play 1 parks carl safe; play 2 (laurie) connects → two runners coexist. */
const SEED_TWO_RUNNERS = 2;
/**
 * Seed 5, play 1: carl's lofted drive is caught pre-bounce by robbie ~29 m
 * out (play 4 is caught too — two chances inside the bounded window).
 */
const SEED_FIRST_PLAY_CAUGHT = 5;
/**
 * Seed 7: run-out dense — plays 2 AND 4 of the sweep resolved runOut with a
 * fielder holding the ball first (gather → throw → run-out), so the bounded
 * outcome loops match quickly.
 */
const SEED_FIRST_PLAY_RUNOUT = 7;
const SEED_THROW_RUNOUT = 7;
/**
 * Full-game seed: verified to run to GAME_OVER with a definite winner. The
 * exact winner is NOT pinned: deep plays are not exactly reproducible under
 * real-time tick jitter (draw-order divergence observed from play ~3 onwards
 * in the Task-3 sweeps), so only structural full-game invariants are asserted.
 */
const SEED_FULL_GAME = 1;
/**
 * Relay seed: seed 5's play 3 exhibited a THREE-link hold chain
 * (josh → kian → ricy) ending in a run-out — a throw → reception → re-throw
 * sequence for the relay/reception room test.
 */
const SEED_RELAY = 5;
/** Loft seed: seed 1's very first hit ballooned to a 22 m apex. */
const SEED_LOFT = 1;
/**
 * WALL seeds: the whale is parked on the pinned seed's OWN play-1 hit
 * corridor — re-derived for the ×2/loft world by the Task-2 sweep (the
 * standard-draft play-1 trajectory is identical under the whale draft: same
 * rng stream head, and failed catch rolls never touch the ball). The spots
 * are TAIL-of-roll samples (~6–7 m/s ground rolls, 18–20 m out): parked
 * mid-corridor the whale CHASED into the descending flight and caught it
 * pre-bounce (first search round, rejected); from the tail his chase
 * intercept is structurally POST-bounce, so a won roll classifies gathered —
 * never caught — by construction AND live verification. Both verified with
 * the whale-draft harness: blocker/gather stop observed (speed < 0.5 within
 * 1.5 m of him), then gather → hold → throw → clean escape; seed 7 resolved
 * safe, seed 8 runOut off the whale's own throw.
 */
const SEED_WALL = 7;
const SEED_WALL_SPOT = { x: 16.5, z: 10.3 };
const SEED_WALL_THROW = 8;
const SEED_WALL_THROW_SPOT = { x: 15.1, z: 10.9 };
/**
 * CLUTCH seed: only carl's CONTACT matters (the gate derives both power
 * hypotheses from the broadcast swing roll itself), retried across up to
 * three rematches; seed pinned for a contact-rich first game (all four sweep
 * plays connected).
 */
const SEED_CLUTCH = 2;

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
 * The parked-ball schema state that finalisePlay repaints (spawnBall +
 * syncBall): bowling square at release height, i.e. the outcome hold is over.
 * A DEAD flight can never show these exact coordinates — a resting ball sits
 * at ground height, never at release height over the bowling square — so this
 * is a race-free finalise signal readable from the schema alone.
 */
function ballParked(room: TestRoom): boolean {
  const b = room.state.ball;
  return (
    Math.abs(b.x - FIELD.BOWLING_SQUARE.x) < 1e-9 &&
    Math.abs(b.y - PHYSICS.BALL_RELEASE_HEIGHT) < 1e-9 &&
    Math.abs(b.z - FIELD.BOWLING_SQUARE.z) < 1e-9
  );
}

/**
 * Wait out the outcome hold (2026-07-05 readable-game overhaul): after the
 * playOutcome broadcast the schema deliberately keeps the death tableau for
 * OUTCOME_HOLD_S sim-seconds; only finalisePlay respawns the ball, settles the
 * runner schema and rebuilds the fielder slots. Every drive helper absorbs the
 * hold before returning, so post-play assertions read the FINALISED world —
 * the exact same facts the pre-overhaul tests asserted, observed later. The
 * dedicated outcome-hold test observes the frozen tableau itself.
 */
async function waitForFinalise(room: TestRoom): Promise<void> {
  await waitForCondition(room, () => ballParked(room), ticksFor(GAME.OUTCOME_HOLD_S + 2));
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
 * Poll until the current play resolves (phase leaves PLAY), then wait out the
 * outcome hold (see waitForFinalise), returning the parsed resolution.
 * Auto-play: a play may loop through several no-contact re-pitches (pitch
 * beat AUTOPLAY_PITCH_DELAY_S → flight → MISS_RESPAWN_S fast respawn →
 * re-schedule) before one connects and resolves, so the tick budget is the
 * derived worst-case play budget.
 */
async function waitPlayEnd(room: TestRoom, maxTicks = PLAY_TICK_BUDGET): Promise<PlayResolution> {
  for (let i = 0; i < maxTicks; i += 1) {
    await room.waitForNextSimulationTick();
    if (room.state.phase !== 'PLAY') break;
  }
  if (room.state.phase === 'PLAY') throw new Error('play did not resolve in time');
  const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
  await waitForFinalise(room);
  return res;
}

/** startPlay + waitPlayEnd: one whole automated play, no client play-messages. */
async function drivePlay(room: TestRoom, clientA: TestClient, clientB: TestClient): Promise<PlayResolution> {
  await startPlay(room, clientA, clientB);
  return waitPlayEnd(room);
}

/** Per-play facts observed while a play runs (for outcome-class predicates). */
interface PlayFacts {
  /** currentBatterId read at the play's start. */
  batter: string;
  /** Every fielder observed holding the ball during the play. */
  holders: Set<string>;
  /** Ordered hold sequence (consecutive duplicates collapsed) — relay/reception chains. */
  holderSeq: string[];
  /** Peak simultaneous runner count observed during the play. */
  maxRunners: number;
  /** True once the auto swing was observed connecting (vz sign flip near the square). */
  contact: boolean;
  /** Ball position at the observed contact tick (lags the true launch by ≤1 poll tick). */
  launch: { x: number; z: number } | null;
  /** Highest ball y observed post-contact while live (loft evidence; the old 0° world stayed ≈ launch height). */
  maxBallY: number;
  /** Ball schema position at the death tick (synced on the resolution tick, then frozen by the hold). */
  deathBall: { x: number; y: number; z: number };
}

/**
 * Drive automated plays until one's RESOLUTION (plus observed facts) satisfies
 * the predicate; returns that play's resolution and facts, or throws at the
 * bound. WHY a bounded loop instead of asserting the pinned seed's play 1
 * directly: run 1 of this suite showed that even a play-1 outcome CLASS can
 * flip under load (identical seed-7 rooms produced caught and safe in the same
 * run — a marginal catch-radius entry appears/disappears with tick-boundary
 * jitter, shifting the shared rng draw order). The pinned seeds still make the
 * FIRST play the likely match; the loop absorbs the marginal-roll jitter
 * without weakening any per-class gate. Callers cap maxPlays ≤ 4 when their
 * assertions need the innings unchanged (a 5th play can drain the queue).
 */
async function drivePlayUntil(
  room: TestRoom,
  clientA: TestClient,
  clientB: TestClient,
  match: (res: PlayResolution, facts: PlayFacts) => boolean,
  maxPlays = 4,
): Promise<{ res: PlayResolution } & PlayFacts> {
  for (let p = 0; p < maxPlays; p += 1) {
    const batter = room.state.currentBatterId;
    const holders = new Set<string>();
    const holderSeq: string[] = [];
    let maxRunners = 0;
    let contact = false;
    let launch: { x: number; z: number } | null = null;
    let maxBallY = 0;
    let prevVz = 0;
    await startPlay(room, clientA, clientB);
    for (let i = 0; i < PLAY_TICK_BUDGET && room.state.phase === 'PLAY'; i += 1) {
      await room.waitForNextSimulationTick();
      const b = room.state.ball;
      for (const f of room.state.fielders.values()) {
        if (f.hasBall) {
          holders.add(f.id);
          if (holderSeq[holderSeq.length - 1] !== f.id) holderSeq.push(f.id);
        }
      }
      if (room.state.runners.size > maxRunners) maxRunners = room.state.runners.size;
      // Contact detection (the CLUTCH test's proven guard set): only the bat
      // flips the polled ball from the incoming pitch's strongly negative vz
      // to a positive one near the batting square.
      if (!contact && prevVz < -5 && b.vz > 1 && b.z < 2) {
        contact = true;
        launch = { x: b.x, z: b.z };
      }
      prevVz = b.vz;
      if (contact && room.state.ballLive && b.y > maxBallY) maxBallY = b.y;
    }
    if (room.state.phase === 'PLAY') throw new Error('play did not resolve in time');
    const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
    // Capture the death tableau's ball BEFORE absorbing the outcome hold —
    // finalisePlay repaints it to the parked spawn state.
    const deathBall = { x: room.state.ball.x, y: room.state.ball.y, z: room.state.ball.z };
    await waitForFinalise(room);
    const facts = { batter, holders, holderSeq, maxRunners, contact, launch, maxBallY, deathBall };
    if (match(res, facts)) return { res, ...facts };
  }
  throw new Error(`no play matched the outcome predicate within ${maxPlays} plays`);
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

  it('phase walk: join → INITIAL_POSITIONING → PRE_PLAY → PLAY → (caught, auto) → PRE_PLAY with an out', async () => {
    // Migrated (auto-play): the caught out was driven by ALWAYS_CATCH + an
    // aimed drive at the bowler; plays now resolve themselves, so the room is
    // seeded with SEED_FIRST_PLAY_CAUGHT (whose first play is a catch) and the
    // walk simply waits for the automatic resolution. Gates unchanged: caught
    // cause, outs 1, batter rotated, back to PRE_PLAY.
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CAUGHT });
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

    // No further client input: the beats deliver, swing, catch and resolve by
    // themselves. Marginal catch rolls make the exact play that gets caught
    // jitter-sensitive (see drivePlayUntil), so the walk closes on the first
    // caught play within the innings-safe window. Gates unchanged: caught
    // cause, an out on the board, the caught batter rotated off, PRE_PLAY.
    const { res, batter } = await drivePlayUntil(room, clientA, clientB, (r) => r.cause.kind === 'caught');
    expect(room.state.phase).toBe('PRE_PLAY');
    expect(res.cause.kind).toBe('caught');
    expect(room.state.battingSide).toBe('A'); // still innings 1 (≤4 plays cannot drain the queue)
    expect(room.state.outs).toBeGreaterThanOrEqual(1);
    expect(room.state.currentBatterId).not.toBe(batter); // the caught batter rotated off
  }, 300000);

  // ---- Auto pitch beat -------------------------------------------------------

  it('the pitch beat fires itself ~AUTOPLAY_PITCH_DELAY_S after PLAY entry: ball live at stat-derived speed, pitch roll broadcast', async () => {
    // Migrated from 'pitch while in PLAY makes the ball live…': the delivery
    // is now the room's own beat — no client message. Same speed band gate
    // (kian pitch 8 → 26.4 m/s minus damping); additionally pins the pitch
    // RollEvent broadcast. ALWAYS_MISS keeps the play in the deterministic
    // no-contact loop so only the delivery is under test.
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    const rolls: RollEvent[] = [];
    clientA.onMessage('roll', (e: RollEvent) => rolls.push(e));
    await startPlay(room, clientA, clientB);
    expect(room.state.ballLive).toBe(false); // beat waits AUTOPLAY_PITCH_DELAY_S
    await waitForCondition(
      room,
      () => room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0,
      ticksFor(GAME.AUTOPLAY_PITCH_DELAY_S + 2),
    );
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20); // Kian pitch 8 → 26.4 m/s minus a tick of damping
    expect(speed).toBeLessThan(27);
    await waitForCondition(room, () => rolls.length > 0, 60);
    expect(rolls[0]?.contest).toBe('pitch');
    expect(rolls[0]?.actorId).toBe('kian');
  }, 20000);

  it('resolves a whole play to a playOutcome with ZERO client play-messages', async () => {
    // NEW (auto-play redesign §7): the core acceptance — a readied play runs
    // pitch → swing → outcome entirely on the room's own beats. Subsumes the
    // old 'full loop … swing connects and reverses flight' gate: the contact
    // seed's hit is observed leaving the bat (vz flips positive) mid-play.
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CONTACT });
    const { clientA, clientB } = await connectPair(room);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });
    await startPlay(room, clientA, clientB);
    let sawHitFlight = false;
    for (let i = 0; i < PLAY_TICK_BUDGET && room.state.phase === 'PLAY'; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ball.vz > 1) sawHitFlight = true;
    }
    expect(room.state.phase).not.toBe('PLAY');
    expect(sawHitFlight).toBe(true); // the auto swing connected and reversed the flight
    const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
    expect(['caught', 'runOut', 'rounder', 'safe']).toContain(res.cause.kind);
    await room.waitForNextSimulationTick();
    expect(received).toEqual(res); // broadcast parity
  }, 300000);

  it('broadcasts rolls in beat order within a play: pitch first, then swing, then only run/catch', async () => {
    // NEW (auto-play redesign §7): the dice moments arrive in contest order.
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CONTACT });
    const { clientA, clientB } = await connectPair(room);
    const rolls: RollEvent[] = [];
    clientA.onMessage('roll', (e: RollEvent) => rolls.push(e));
    await drivePlay(room, clientA, clientB);
    // Broadcasts land asynchronously: wait until the connecting swing's roll
    // has actually ARRIVED (under load a single tick is not enough).
    await waitForCondition(room, () => rolls.some((r) => r.contest === 'swing' && r.success), 120);
    // A play may loop pitch→(missed swing)→pitch…; every loop is pitch-then-
    // swing, and run/catch rolls only ever follow a successful swing.
    expect(rolls.length).toBeGreaterThanOrEqual(2);
    expect(rolls[0]?.contest).toBe('pitch');
    let lastPitchIdx = -1;
    rolls.forEach((r, i) => {
      if (r.contest === 'pitch') {
        // Every re-pitch follows a FAILED swing (missed) — never a contact.
        if (i > 0) expect(rolls[i - 1]).toMatchObject({ contest: 'swing', success: false });
        lastPitchIdx = i;
      }
      if (r.contest === 'swing') expect(i).toBe(lastPitchIdx + 1); // swing immediately follows its pitch
      if (r.contest === 'run' || r.contest === 'catch') {
        // Run/catch rolls belong to the final (connected) swing's play phase.
        const swingIdx = rolls.findIndex((x, j) => j < i && x.contest === 'swing' && x.success);
        expect(swingIdx).toBeGreaterThanOrEqual(0);
        expect(i).toBeGreaterThan(swingIdx);
      }
    });
    // The connected play's swing roll reports success (presentation = reality).
    const lastSwing = [...rolls].reverse().find((r) => r.contest === 'swing');
    expect(lastSwing?.success).toBe(true);
  }, 300000);

  // ---- Tombstoned player play-messages ---------------------------------------

  it("rejects pitch/swing/runDecision from EITHER side with exactly 'plays resolve automatically'", async () => {
    // Migrated: replaces the whole family of per-payload pitch/swing/runDecision
    // validation tests ('second pitch while live', 'swing with no ball',
    // payload-less/null payload crash guards, wrong-role play messages). The
    // handlers are tombstones — every payload, role and phase now gets the one
    // unconditional prose reason, and junk payloads are trivially safe because
    // the payload is never read. The 'stays responsive' gate is preserved by
    // the beat still delivering after the junk (asserted at the end).
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    const rejectsA: { message: string; reason: string }[] = [];
    const rejectsB: { message: string; reason: string }[] = [];
    clientA.onMessage('rejected', (p: { message: string; reason: string }) => rejectsA.push(p));
    clientB.onMessage('rejected', (p: { message: string; reason: string }) => rejectsB.push(p));
    await startPlay(room, clientA, clientB);

    clientA.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 }); // batting side
    clientB.send('pitch'); // fielding side, payload-less
    clientA.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    clientB.send('swing', null);
    clientA.send('runDecision', { go: true });
    clientB.send('runDecision');
    await waitForCondition(room, () => rejectsA.length >= 3 && rejectsB.length >= 3, 120);

    expect(rejectsA.map((r) => r.message)).toEqual(['pitch', 'swing', 'runDecision']);
    expect(rejectsB.map((r) => r.message)).toEqual(['pitch', 'swing', 'runDecision']);
    for (const r of [...rejectsA, ...rejectsB]) expect(r.reason).toBe('plays resolve automatically');

    // Still alive: the pitch beat delivers regardless of the junk above.
    await waitForCondition(room, () => room.state.ballLive, ticksFor(GAME.AUTOPLAY_PITCH_DELAY_S + 2));
  }, 60000);

  // ---- Running -------------------------------------------------------------

  it('a connected auto-swing starts a runner heading towards post 1', async () => {
    // Migrated from the aimed pitchThenSwing idiom: the contact seed's first
    // play connects by itself; the runner is observed mid-circuit. Gates
    // unchanged: the batter-runner exists, is running, is between posts, not out.
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CONTACT });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    // Budget: the contact seed's connect may still take a couple of re-pitch
    // loops under jitter (pitch delay + flight + miss respawn per loop).
    await waitForCondition(
      room,
      () => room.state.runners.size > 0,
      ticksFor(3 * (GAME.AUTOPLAY_PITCH_DELAY_S + GAME.MISS_RESPAWN_S + 2)),
    );
    const runner = room.state.runners.get(OPENER_ID);
    expect(runner).toBeDefined();
    expect(runner?.running).toBe(true);
    expect(runner?.atPost).toBe(-1);
    expect(runner?.out).toBe(false);
  }, 120000);

  it('an auto run decision can park the runner safe at a post, ending the play there', async () => {
    // Migrated from 'runDecision {go:false} halts the runner at post 1…': the
    // stop/go is now the room's own run beat (rolled at contact and at each
    // post arrival), so the halted-safe outcome is exhibited by a pinned seed
    // (first safe play within the innings-safe window — see drivePlayUntil).
    // Gates preserved: cause 'safe' naming that play's own batter-runner, the
    // schema runner PARKED (not running) at exactly the resolution's post, no
    // outs, and score consistency with the parked post.
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_SAFE });
    const { clientA, clientB } = await connectPair(room);
    const { res, batter } = await drivePlayUntil(room, clientA, clientB, (r) => r.cause.kind === 'safe');
    const safe = res.cause as Extract<PlayOutcome, { kind: 'safe' }>;
    expect(safe.runnerId).toBe(batter); // 'safe' always names the play's own batter-runner
    expect(safe.atPost).toBeGreaterThanOrEqual(1);
    const runner = room.state.runners.get(batter);
    expect(runner?.atPost).toBe(safe.atPost);
    expect(runner?.running).toBe(false);
    expect(runner?.out).toBe(false);
    expect(res.outs).toEqual([]);
    expect(res.scoreDeltaHalves).toBe(safe.atPost >= 2 ? 1 : 0); // half-rounder line is post 2
  }, 300000);

  // ---- Run-out detection (migrated) ----------------------------------------

  it('the ball reaching an exposed post while the runner is mid-segment is a run-out', async () => {
    // Migrated from 'a hit flown directly at an exposed post…': tests can no
    // longer aim the hit, so a pinned seed with runOut-dense opening plays
    // exhibits the same detection path (exposure-scoped sensor crossing or
    // holder-at-post). Gates preserved: runOut cause naming the batter-runner
    // and the post, the runner in outs, broadcast parity, ball dead, fielders
    // rebuilt on their slots (bowler back on the bowling square).
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_RUNOUT });
    const { clientA, clientB } = await connectPair(room);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    // First runOut play within the innings-safe window (see drivePlayUntil).
    // NOTE the runner is asserted via the resolution, not pinned to the play's
    // batter: a run-out may legitimately claim a PARKED survivor forced on by
    // the shared go decision, not only the striker.
    const { res } = await drivePlayUntil(room, clientA, clientB, (r) => r.cause.kind === 'runOut');
    await room.waitForNextSimulationTick(); // let the broadcast land
    const runOut = res.cause as Extract<PlayOutcome, { kind: 'runOut' }>;
    expect(runOut.atPost).toBeGreaterThanOrEqual(1);
    expect(runOut.runnerId.length).toBeGreaterThan(0);
    expect(res.outs).toContain(runOut.runnerId);
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(res);
    // drivePlayUntil absorbed the outcome hold, so the fielders are REBUILT
    // here (2026-07-05: the slot return happens at finalise, not resolve).
    const bowler = room.state.fielders.get('kian'); // still innings 1: B fields, kian re-slotted
    expect(bowler?.x).toBeCloseTo(FIELD.BOWLING_SQUARE.x, 9);
    expect(bowler?.z).toBeCloseTo(FIELD.BOWLING_SQUARE.z, 9);
  }, 300000);

  // RETIRED (documented in the Task-3 report): the two stale-crossing
  // choreography tests ('a stale post crossing from earlier in flight…' and
  // 'a crossing while the runner is HALTED…') drove the exposure-window guard
  // via player-timed runDecision halt/go injections. runDecision is tombstoned
  // — the between-tick decision seam those tests aimed at no longer EXISTS at
  // the wire (auto run beats apply setDecision inside the tick, after the
  // run-out check), so the choreography is not reconstructible from outside.
  // The guard itself (checkRunOut's snapshot conditions + clearPostCrossings)
  // is unchanged, runs on every play of every seeded test here, and keeps its
  // physics-layer unit coverage (PhysicsModule crossing-latch tests).

  // ---- Catch / throw pipeline (migrated) -----------------------------------

  it('an auto play can end caught (pre-bounce) → the batter is out', async () => {
    // Migrated from the ALWAYS_CATCH + drive-at-the-bowler idiom (rng 0 now
    // guarantees a swing MISS, so forced catches are impossible — see the
    // ALWAYS_MISS comment). SEED_FIRST_PLAY_CAUGHT's first play is caught.
    // Gates preserved: caught by a fielding-squad member, batter in outs,
    // outs incremented (absorbs the old 'caught batter increments outs' test),
    // ball dead, broadcast parity.
    const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CAUGHT });
    const { clientA, clientB } = await connectPair(room);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    // First caught play within the innings-safe window (see drivePlayUntil).
    const { res, batter } = await drivePlayUntil(room, clientA, clientB, (r) => r.cause.kind === 'caught');
    await room.waitForNextSimulationTick();

    expect(DRAFTED_B).toContain((res.cause as Extract<PlayOutcome, { kind: 'caught' }>).by); // innings 1: B fields
    expect(res.outs).toContain(batter); // the caught batter is out
    expect(res.outs.length).toBe(1);
    expect(room.state.outs).toBeGreaterThanOrEqual(1); // still innings 1 within the window
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(res);
  }, 300000);

  it('a gathered ball is thrown at the exposed post for a run-out (full throw pipeline)', async () => {
    // Migrated from the corridor-gather custom-rng choreography (a state-
    // reading rng can no longer choreograph anything — it also drives the
    // auto decisions, and its 0.999 arm forbids bat contact entirely).
    // SEED_THROW_RUNOUT exhibits the pipeline naturally: a fielder HOLDS the
    // ball (hasBall observed mid-play) and the play resolves runOut — gather →
    // throw → ball at the exposed post. Gates preserved: holder seen, runOut
    // cause, runner in outs, ball dead, broadcast parity. The specific
    // holder/post are seed facts, not re-assertable aims.
    const room = await colyseus.createRoom('match', { seed: SEED_THROW_RUNOUT });
    const { clientA, clientB } = await connectPair(room);
    let received: PlayResolution | null = null;
    clientA.onMessage('playOutcome', (payload: PlayResolution) => {
      received = payload;
    });

    // First play that BOTH held the ball and resolved runOut (same play — the
    // holders set is per play in drivePlayUntil), within a two-innings window.
    const { res, holders } = await drivePlayUntil(
      room,
      clientA,
      clientB,
      (r, f) => r.cause.kind === 'runOut' && f.holders.size > 0,
      12, // holder+runOut plays are common but not per-window-certain; 12 spans two innings safely
    );
    await room.waitForNextSimulationTick();

    expect(holders.size).toBeGreaterThan(0); // a fielder really gathered and held the ball
    expect(res.cause.kind).toBe('runOut');
    expect(res.outs.length).toBe(1);
    expect(room.state.ballLive).toBe(false);
    expect(received).toEqual(res);
  }, 900000);

  // ---- Rejection matrix (structured broadcast) -----------------------------

  it('rejects every message out of its phase, broadcasting a structured { message, phase, reason }', async () => {
    // ALWAYS_MISS: no bat contact ever, so once entered PLAY holds for the
    // whole PLAY-phase row block (an unseeded room could resolve mid-matrix).
    const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
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
    // A full rounder (home, +2 halves, batter re-queues) remains unreachable in
    // the room (circuit ~115 m on the ×2 field vs PLAY_TIMEOUT_S 12 s —
    // RulesModule unit tests cover it); the reachable scoring rung is the
    // half-rounder. Migrated from
    // the aimed max-elevation loft: SEED_HALF_ROUNDER's designated play banks
    // +1 half via the auto beats. Gates preserved: not an out, the scoring
    // runner parked at post ≥ 2, scoreDeltaHalves 1, banked for side A only.
    const room = await colyseus.createRoom('match', { seed: SEED_HALF_ROUNDER });
    const { clientA, clientB } = await connectPair(room);
    // First safe-at-≥2 play within the innings-safe window (see drivePlayUntil).
    const { res } = await drivePlayUntil(
      room,
      clientA,
      clientB,
      (r) => r.cause.kind === 'safe' && r.cause.atPost >= 2,
    );
    const safe = res.cause as Extract<PlayOutcome, { kind: 'safe' }>;
    expect(safe.atPost).toBeGreaterThanOrEqual(2);
    expect(room.state.runners.get(safe.runnerId)?.atPost).toBe(safe.atPost);
    expect(res.scoreDeltaHalves).toBe(1);
    expect(room.state.scoreHalvesA).toBeGreaterThanOrEqual(1); // banked for the batting side (innings 1)
    expect(room.state.scoreHalvesB).toBe(0);
    expect(res.outs).toEqual([]);
  }, 300000);

  // (The old separate 'a caught batter increments the batting side outs' test
  // is absorbed by the caught-outcome test above — same seed, same gates.)

  // ---- Multi-runner --------------------------------------------------------

  it('two runners are visible in the schema after a play where the first parked safe', async () => {
    // Migrated: play 1's park and play 2's contact now come from the pinned
    // seed's own decisions instead of an injected go:false + aimed swings.
    // Gates preserved: after a parked-safe play the NEXT batter's contact puts
    // TWO runners in the schema — the parked survivor and the new batter-runner.
    const room = await colyseus.createRoom('match', { seed: SEED_TWO_RUNNERS });
    const { clientA, clientB } = await connectPair(room);

    // Two simultaneous runners REQUIRE a parked survivor from an earlier play
    // plus the current play's batter-runner, so observing maxRunners ≥ 2 IS
    // the gate; the pinned seed exhibits it by play 2 (park, then contact).
    const { maxRunners } = await drivePlayUntil(room, clientA, clientB, (_r, f) => f.maxRunners >= 2);
    expect(maxRunners).toBeGreaterThanOrEqual(2); // a parked survivor + the current batter-runner coexisted
  }, 600000);

  // ---- Full game / rematch -------------------------------------------------

  it('plays a full headless game through to GAME_OVER with a winner', async () => {
    // Migrated from the flip-rng choreography (score once, then force catches):
    // a custom rng can no longer steer plays, so the marquee test simply lets a
    // pinned seed's auto beats play the WHOLE game out. Termination is
    // structural (each play consumes the current batter; a drained queue ends
    // the innings). NOTE the old 'winner === A' pin is NOT carried over: it was
    // an artefact of the rng steering, and a 20+-play game is not exactly
    // reproducible under real-time tick jitter (deep-play draw-order divergence
    // was observed in the Task-3 seed sweeps), so pinning the exact winner
    // would be flake bait. The real invariants ARE kept: GAME_OVER reached, a
    // DEFINITE winner, and the winner strictly outscoring the loser.
    const room = await colyseus.createRoom('match', { seed: SEED_FULL_GAME });
    const { clientA, clientB } = await connectPair(room);

    let plays = 0;
    while (room.state.phase !== 'GAME_OVER' && plays < 100) {
      await drivePlay(room, clientA, clientB);
      plays += 1;
    }

    expect(room.state.phase).toBe('GAME_OVER');
    expect(['A', 'B']).toContain(room.state.winner);
    const winnerScore = room.state.winner === 'A' ? room.state.scoreHalvesA : room.state.scoreHalvesB;
    const loserScore = room.state.winner === 'A' ? room.state.scoreHalvesB : room.state.scoreHalvesA;
    expect(winnerScore).toBeGreaterThan(loserScore);
  }, 1800000);

  it('rematch at GAME_OVER resets to INITIAL_POSITIONING with a zeroed score', async () => {
    // Migrated: same seed as the marquee test drives to GAME_OVER, then the
    // rematch gates are unchanged from M5.
    const room = await colyseus.createRoom('match', { seed: SEED_FULL_GAME });
    const { clientA, clientB } = await connectPair(room);

    let plays = 0;
    while (room.state.phase !== 'GAME_OVER' && plays < 100) {
      await drivePlay(room, clientA, clientB);
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
  }, 1800000);

  it('garbage rng/seed join options cannot break the room (runtime-validated)', async () => {
    // Migrated: the gate is unchanged — junk options fall back to a wall-clock
    // seed and the room keeps functioning. What CAN'T carry over is awaiting a
    // full resolution (the fallback seed is unknown, so contact timing is not
    // deterministic); instead the test proves the auto pitch beat delivers at
    // stat speed on the fallback rng and that ~4 s of live auto-play (through
    // at least one full pitch/decision cycle) raises no uncaught exceptions.
    const errorSpy = vi.spyOn(console, 'error');
    const garbage = { rng: 1, seed: 'not-a-number' } as unknown as Record<string, unknown>;
    const room = await colyseus.createRoom('match', garbage);
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);

    await waitForCondition(
      room,
      () => room.state.ballLive && Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz) > 0,
      ticksFor(GAME.AUTOPLAY_PITCH_DELAY_S + 2),
    );
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);

    // Watch through at least one full pitch → miss → fast-respawn cycle.
    for (let i = 0; i < ticksFor(GAME.AUTOPLAY_PITCH_DELAY_S + GAME.MISS_RESPAWN_S + 2) && room.state.phase === 'PLAY'; i += 1) {
      await room.waitForNextSimulationTick();
    }
    const uncaught = errorSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[MatchRoom] uncaught exception'),
    );
    expect(uncaught).toEqual([]);
  }, 60000);

  // ---- Readable-game overhaul (2026-07-05): hold, arming, relay, respawn, loft ----

  describe('readable-game overhaul', () => {
    it('outcome hold: the death tableau freezes for OUTCOME_HOLD_S after the resolution, then the field rebuilds on its slots', async () => {
      // NEW (2026-07-05 overhaul §B5): resolvePlayNow broadcasts playOutcome
      // and freezes the schema exactly as the play died; only finalisePlay
      // (OUTCOME_HOLD_S sim-seconds later) respawns the ball and repaints
      // runner/fielder schema. Gates: at resolution the ball is NOT parked,
      // every fielder position is bit-identical on every tick of the hold,
      // the hold demonstrably lasts, and finalise rebuilds the five EXACTLY
      // on their slots.
      const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CONTACT });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      for (let i = 0; i < PLAY_TICK_BUDGET && room.state.phase === 'PLAY'; i += 1) {
        await room.waitForNextSimulationTick();
      }
      expect(room.state.phase).not.toBe('PLAY');

      // The death tableau: the ball is wherever the play died, not respawned.
      expect(ballParked(room)).toBe(false);
      const tableau = [...room.state.fielders.values()].map((f) => ({ id: f.id, x: f.x, z: f.z }));
      const deadBall = { x: room.state.ball.x, y: room.state.ball.y, z: room.state.ball.z };
      let frozenTicks = 0;
      while (!ballParked(room)) {
        // finalise must arrive within the hold (+ headroom) — a stuck hold fails loudly.
        expect(frozenTicks).toBeLessThan(ticksFor(GAME.OUTCOME_HOLD_S + 2));
        await room.waitForNextSimulationTick();
        if (ballParked(room)) break;
        // Frozen: nothing repaints fielders or the ball mid-hold.
        for (const f of tableau) {
          expect(room.state.fielders.get(f.id)?.x).toBe(f.x);
          expect(room.state.fielders.get(f.id)?.z).toBe(f.z);
        }
        expect(room.state.ball.x).toBe(deadBall.x);
        expect(room.state.ball.z).toBe(deadBall.z);
        frozenTicks += 1;
      }
      // The hold visibly lasted. Lower bound is load-proof, not wall-clock:
      // each tick advances sim time by at most SIM_MAX_CATCHUP, so the hold
      // can NEVER elapse in fewer ticks than this quotient even if the event
      // loop stalls (typically it takes ~OUTCOME_HOLD_S × 60 ticks).
      expect(frozenTicks).toBeGreaterThanOrEqual(Math.floor(GAME.OUTCOME_HOLD_S / PHYSICS.SIM_MAX_CATCHUP));

      // Finalised: the drafted five rebuilt EXACTLY on their slots (innings 1:
      // B fields, kian back on the bowling square).
      const onField = ['kian', ...DRAFTED_B.filter((id) => id !== 'kian')];
      onField.forEach((id, i) => {
        const f = room.state.fielders.get(id);
        const slot = FIELD.FIELDING_POSITIONS[i];
        expect(f?.x).toBeCloseTo(slot?.x ?? NaN, 9);
        expect(f?.z).toBeCloseTo(slot?.z ?? NaN, 9);
      });
    }, 300000);

    it('catch arming: a caught play is only ever caught beyond CATCH_ARM_DISTANCE_M of the launch point', async () => {
      // NEW (2026-07-05 overhaul §B2): the old world's backstop caught the
      // ball ON the contact tick (travel ≈ 0.4 m). With catch arming, every
      // catch/gather attempt is suppressed until the flight has travelled
      // CATCH_ARM_DISTANCE_M from launch, so a caught resolution's death ball
      // (schema synced on the catch tick, then frozen by the hold) must sit at
      // least the arm distance out. Tolerances: the observed launch lags the
      // true one by ≤1 poll tick (≤ ~0.6 m at exit speeds) and the assert is
      // 2D while arming is 3D (up to ~0.3 m more at catch heights) — hence
      // the −1 m allowance, still 3× the old contact-tick travel.
      const room = await colyseus.createRoom('match', { seed: SEED_FIRST_PLAY_CAUGHT });
      const { clientA, clientB } = await connectPair(room);
      const { res, contact, launch, deathBall } = await drivePlayUntil(
        room,
        clientA,
        clientB,
        (r) => r.cause.kind === 'caught',
      );
      expect(res.cause.kind).toBe('caught');
      expect(contact).toBe(true);
      expect(launch).not.toBeNull();
      const travelled = Math.hypot(deathBall.x - (launch?.x ?? 0), deathBall.z - (launch?.z ?? 0));
      expect(travelled).toBeGreaterThanOrEqual(GAME.CATCH_ARM_DISTANCE_M - 1);
    }, 300000);

    it('relay/reception chain: two fielders hold in one play and the reception never dismisses the batter', async () => {
      // NEW (2026-07-05 overhaul §B3 + the thrown-flight fix): a holder can
      // only release the ball by THROWING, so an ordered two-holder sequence
      // is a throw → teammate reception chain (relay target or post cover —
      // the exact relay-target selection is pinned at the FieldingModule unit
      // layer; the room pins the observable chain). With the thrown-flight
      // guard the reception classifies gathered, never caught — so a play
      // with any completed hold can never resolve 'caught'.
      const room = await colyseus.createRoom('match', { seed: SEED_RELAY });
      const { clientA, clientB } = await connectPair(room);
      const { res, holderSeq } = await drivePlayUntil(
        room,
        clientA,
        clientB,
        (_r, f) => new Set(f.holderSeq).size >= 2,
        12, // reception chains are common but not per-window-certain; 12 spans two innings safely
      );
      expect(new Set(holderSeq).size).toBeGreaterThanOrEqual(2);
      expect(res.cause.kind).not.toBe('caught');
    }, 900000);

    it('a missed swing respawns the ball after ~MISS_RESPAWN_S — the re-pitch arrives fast, not at the roll-to-rest pace', async () => {
      // NEW (2026-07-05 overhaul §B4): ALWAYS_MISS guarantees every swing
      // fails, so the play cycles pitch → miss → fast respawn → re-pitch. The
      // gap from a failed swing roll to the NEXT pitch roll is measured in
      // wall time (ticks run at real 60 Hz): expected MISS_RESPAWN_S +
      // AUTOPLAY_PITCH_DELAY_S ≈ 3 s; the OLD roll-to-rest path took ~7 s+ of
      // flight/rolling before the rest latch even started — cleanly outside
      // the generous upper bound.
      const room = await colyseus.createRoom('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      const stamps: { contest: string; success: boolean; at: number }[] = [];
      clientA.onMessage('roll', (e: RollEvent) => {
        stamps.push({ contest: e.contest, success: e.success, at: Date.now() });
      });
      await startPlay(room, clientA, clientB);
      await waitForCondition(
        room,
        () => stamps.filter((s) => s.contest === 'pitch').length >= 2,
        ticksFor(2 * (GAME.AUTOPLAY_PITCH_DELAY_S + GAME.MISS_RESPAWN_S + 3)),
      );
      const swingIdx = stamps.findIndex((s) => s.contest === 'swing' && !s.success);
      expect(swingIdx).toBeGreaterThan(0); // a pitch precedes it
      const nextPitch = stamps.slice(swingIdx + 1).find((s) => s.contest === 'pitch');
      expect(nextPitch).toBeDefined();
      const gapS = ((nextPitch?.at ?? 0) - (stamps[swingIdx]?.at ?? 0)) / 1000;
      const expected = GAME.MISS_RESPAWN_S + GAME.AUTOPLAY_PITCH_DELAY_S;
      expect(gapS).toBeGreaterThanOrEqual(expected - 1.5); // delivery-jitter headroom
      expect(gapS).toBeLessThanOrEqual(expected + 2.5); // the old rest path can never fit under this
    }, 120000);

    it('loft: an auto hit visibly climbs after contact — the 0°-forever line drive is dead', async () => {
      // NEW (2026-07-05 overhaul §B1): swings sample a real launch elevation
      // in [LOFT_MIN, LOFT_MAX]. The unit layer pins the sampled band exactly;
      // the room pins the observable consequence — post-contact the ball GAINS
      // height. The old 0° aim could never exceed ~launch height (~1 m, no
      // upward velocity component existed), so a 2.5 m apex is unreachable
      // pre-overhaul and routine now.
      const room = await colyseus.createRoom('match', { seed: SEED_LOFT });
      const { clientA, clientB } = await connectPair(room);
      const { contact, maxBallY } = await drivePlayUntil(
        room,
        clientA,
        clientB,
        (_r, f) => f.contact && f.maxBallY >= 2.5,
        8, // no innings-dependent asserts — the window may cross a switch
      );
      expect(contact).toBe(true);
      expect(maxBallY).toBeGreaterThanOrEqual(2.5);
    }, 600000);
  });

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
      // Migrated from the ALWAYS_CATCH caught-per-play idiom. The old exact
      // 'plays === 5' gate CANNOT survive auto-play: under auto-running a
      // parked survivor regularly completes his circuit across LATER plays and
      // re-queues (home re-queues, spec §8 — the Task-3 probe saw an 11-play
      // innings), so innings length is variable-but-≥5. Gates now: the innings
      // takes at least the queue length in plays, battingSide flips to B, and
      // A's five field with joel (A's best arm) re-derived as default pitcher.
      const room = await colyseus.createRoom<MatchState>('match', { seed: SEED_FULL_GAME });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      let plays = 0;
      while (room.state.battingSide === 'A' && room.state.phase !== 'GAME_OVER' && plays < 25) {
        await drivePlay(room, clientA, clientB);
        plays += 1;
      }
      expect(plays).toBeGreaterThanOrEqual(5); // every original queue member must bat at least once
      expect(room.state.battingSide).toBe('B');
      // drivePlay absorbed the innings-switching play's outcome hold, so the
      // side swap + pitcher re-derivation (finalise-time work, 2026-07-05)
      // have landed by the time the loop exits.
      expect(room.state.currentPitcherId).toBe('joel'); // A fields now; joel has A's best arm (pitch 9)
      expect(room.state.fielders.size).toBe(5);
      expect([...room.state.fielders.keys()].sort()).toEqual(['carl', 'joe', 'joel', 'jonty', 'laurie']);
    }, 1800000);
  });

  // ---- M6: role gating -------------------------------------------------------

  describe('M6 role gating', () => {
    // RETIRED (documented in the Task-3 report): 'rejects a pitch from the
    // batting side and accepts it from the fielding side' and 'rejects swing
    // and runDecision from the fielding side' gated PLAYER play-messages by
    // role. Those messages are tombstoned — no role can send them any more, so
    // the role gates they tested no longer exist. Their rejection surface is
    // covered by the tombstone test (both sides, exact prose); role gating on
    // the SURVIVING messages (setPitcher/reposition/substitute/setBatter/
    // draftPick) keeps its own wrongRole tests below and in M7/M8.

    it('delivers a rejected message ONLY to the offending client, never broadcasting it to the other', async () => {
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      await startPlay(room, clientA, clientB);
      const rejectsA: unknown[] = [];
      const rejectsB: unknown[] = [];
      clientA.onMessage('rejected', (p: unknown) => rejectsA.push(p));
      clientB.onMessage('rejected', (p: unknown) => rejectsB.push(p));

      // Any pitch is now a routine tombstone rejection ('plays resolve
      // automatically') — still targeted at the offender only, never broadcast.
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
      // The auto pitch beat puts the ball demonstrably in flight (no client pitch any more).
      await waitForCondition(
        room,
        () => room.state.ballLive && room.state.ball.z > 1,
        ticksFor(GAME.AUTOPLAY_PITCH_DELAY_S + 2),
      );
      const token = clientB.reconnectionToken;
      await clientB.leave(false); // unconsented
      await waitForCondition(room, () => room.state.paused);
      const frozen = { x: room.state.ball.x, z: room.state.ball.z };
      for (let i = 0; i < 30; i += 1) await room.waitForNextSimulationTick();
      expect(room.state.ball.x).toBe(frozen.x);
      expect(room.state.ball.z).toBe(frozen.z);
      // Messages are rejected while paused — the paused-first check outranks
      // even the tombstone prose (M6 ordering kept by the redesign brief).
      clientA.send('swing', { timing: 0, aim: { x: 0.55, y: 0.47, z: 0.65 }, spinInput: 0 });
      await room.waitForNextSimulationTick();
      expect(JSON.parse(room.state.lastRejection).reason).toBe('paused');
      const rejoined = await colyseus.sdk.reconnect(token);
      await waitForCondition(room, () => !room.state.paused);
      expect(room.state.connectedB).toBe(true);
      await rejoined.leave();
    });

    it('pause freezes the beats: no roll broadcasts while paused across ≥1 s real time, resuming on reconnect', async () => {
      // NEW (auto-play redesign §7): beats compare against simTime, which the
      // paused tick never advances — verified, not assumed. The drop lands
      // BEFORE the first pitch beat (AUTOPLAY_PITCH_DELAY_S), so a beat
      // firing while paused would be caught as a roll broadcast / live ball.
      const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
      const { clientA, clientB } = await connectPair(room);
      const rolls: RollEvent[] = [];
      clientA.onMessage('roll', (e: RollEvent) => rolls.push(e));
      await startPlay(room, clientA, clientB);
      const token = clientB.reconnectionToken;
      await clientB.leave(false); // unconsented, immediately after PLAY entry
      await waitForCondition(room, () => room.state.paused);
      // The drop usually lands well inside the 1 s pitch delay (beat not yet
      // fired); if the beat won that race the ball is frozen mid-flight —
      // either way NOTHING may advance while paused, which is the invariant.
      const rollsAtPause = rolls.length;
      const frozen = { live: room.state.ballLive, x: room.state.ball.x, z: room.state.ball.z };
      // Strictly MORE than the pitch delay of real time, derived so a pacing
      // retune can never silently make this window shorter than the beat.
      await new Promise((resolve) => setTimeout(resolve, (GAME.AUTOPLAY_PITCH_DELAY_S + 0.3) * 1000));
      expect(rolls.length).toBe(rollsAtPause); // no roll broadcasts while frozen
      expect(room.state.ballLive).toBe(frozen.live);
      expect(room.state.ball.x).toBe(frozen.x);
      expect(room.state.ball.z).toBe(frozen.z);

      const rejoined = await colyseus.sdk.reconnect(token);
      await waitForCondition(room, () => !room.state.paused);
      // Unpaused: sim time resumes, beats resume — new rolls arrive (the pitch
      // beat if it was still pending, otherwise the frozen flight's next beat).
      await waitForCondition(
        room,
        () => rolls.length > rollsAtPause,
        ticksFor(GAME.AUTOPLAY_PITCH_DELAY_S + GAME.MISS_RESPAWN_S + 3),
      );
      await rejoined.leave();
    }, 60000);

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
      // Migrated from the ALWAYS_CATCH caught-per-play idiom: each innings now
      // runs a VARIABLE number of plays (home re-queues under auto-running —
      // see the innings-switch test), so the loops are capped generously and
      // exit on the battingSide flip. After two full innings the game is at
      // innings 3 of 4 — NEVER GAME_OVER — so the return-intact assertion is
      // unconditional (the old version's `if` guard is gone: stronger, not
      // weaker). Gates preserved: A's five field innings 2; josh's custom
      // (5, 20) returns when B fields again.
      const room = await colyseus.createRoom<MatchState>('match', { seed: SEED_FULL_GAME });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      clientB.send('reposition', { id: 'josh', x: 5, z: 20 });
      await waitForCondition(room, () => room.state.fielders.get('josh')?.x === 5);
      let plays = 0;
      while (room.state.battingSide === 'A' && room.state.phase !== 'GAME_OVER' && plays < 25) {
        await drivePlay(room, clientA, clientB);
        plays += 1;
      }
      expect(room.state.battingSide).toBe('B');
      expect(room.state.fielders.get('joel')).toBeDefined(); // A's five field now
      plays = 0;
      while (room.state.battingSide === 'B' && room.state.phase !== 'GAME_OVER' && plays < 25) {
        await drivePlay(room, clientA, clientB);
        plays += 1;
      }
      expect(room.state.phase).not.toBe('GAME_OVER'); // innings 3 of 4
      // drivePlay absorbed the second switch's outcome hold: the returning
      // layout (finalise-time rebuild, 2026-07-05) has landed here.
      expect(room.state.fielders.get('josh')?.x).toBe(5); // B's custom layout came back
      expect(room.state.fielders.get('josh')?.z).toBe(20);
    }, 1800000);

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
      // Migrated from the aimed pitchThenSwing contact: every RESOLVED auto
      // play had bat contact by construction (the no-contact branch respawns
      // without resolving), so one drivePlay guarantees a chaser sprinted.
      // Gate unchanged: some on-field fielder sits below stat stamina in the
      // NEXT play's rebuilt setup — the ledger carried the drain across plays.
      const room = await colyseus.createRoom<MatchState>('match', { seed: SEED_FULL_GAME, fieldSlotsOverride: 3 });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftSquads(room, clientA, clientB);
      await drivePlay(room, clientA, clientB);
      // A chaser sprinted last play: SOME on-field fielder is below stat stamina next play.
      const drained = [...room.state.fielders.values()].some(
        (f) => f.stamina < (CHARACTERS.find((c) => c.id === f.id)?.stats.stamina ?? 0),
      );
      expect(drained).toBe(true);
    }, 300000);
  });

  // ---- M9: abilities (room wiring) -------------------------------------------

  describe('M9 abilities', () => {
    /**
     * Custom draft: B takes the whale FIRST, then kian. Among B's five
     * (whale pitch 4, kian 8, josh 6, darcy 6, robbie 5) kian remains the
     * best arm, so the default pitcher is unchanged from the standard draft.
     */
    async function draftWithWhale(room: TestRoom, clientA: TestClient, clientB: TestClient): Promise<void> {
      const picksA = ['carl', 'laurie', 'joel', 'jonty', 'joe'];
      const picksB = ['whale', 'kian', 'josh', 'darcy', 'robbie'];
      let a = 0;
      let b = 0;
      while (room.state.draftTurn !== '') {
        const turn = room.state.draftTurn;
        const id = (turn === 'A' ? picksA[a++] : picksB[b++]) ?? '';
        const picker = turn === 'A' ? clientA : clientB;
        const before = room.state.squadAIds.length + room.state.squadBIds.length;
        picker.send('draftPick', { id });
        await waitForCondition(room, () => room.state.squadAIds.length + room.state.squadBIds.length > before);
      }
      await waitForPhase(room, 'INITIAL_POSITIONING');
    }

    it('WALL: a drive stops dead at the whale and the play resolves without a caught-from-stop', async () => {
      // Migrated from ALWAYS_MISS + the aimed flat drive: tests can no longer
      // aim, so the whale is parked on the PINNED seed's own play-1 hit
      // corridor (SEED_WALL_SPOT — re-derived by the Task-2 sweep for the
      // ×2/loft world from this seed's observed deterministic play-1 roll,
      // then pinned; see the constant's comment for the tail-of-roll
      // placement rationale). Gates preserved: the drive dies at the whale,
      // the play still resolves, and the stop is never classified 'caught' —
      // the ball reaches him post-bounce, so even a WON roll is a gather,
      // verified live in the search.
      const room = await colyseus.createRoom<MatchState>('match', { seed: SEED_WALL });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftWithWhale(room, clientA, clientB);
      expect(room.state.currentPitcherId).toBe('kian');
      expect(room.state.fielders.get('whale')).toBeDefined();

      clientB.send('reposition', { id: 'whale', x: SEED_WALL_SPOT.x, z: SEED_WALL_SPOT.z });
      await waitForCondition(room, () => room.state.fielders.get('whale')?.z === SEED_WALL_SPOT.z);

      await startPlay(room, clientA, clientB);

      // The drive must die at the whale: ball speed collapses while it is near him.
      let stoppedNearWhale = false;
      for (let i = 0; i < PLAY_TICK_BUDGET && room.state.phase === 'PLAY'; i += 1) {
        await room.waitForNextSimulationTick();
        const whale = room.state.fielders.get('whale');
        if (whale === undefined || !room.state.ballLive) continue;
        const d = Math.hypot(room.state.ball.x - whale.x, room.state.ball.z - whale.z);
        const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
        if (d < 1.5 && speed < 0.5) stoppedNearWhale = true;
      }
      expect(stoppedNearWhale).toBe(true);

      // The play still resolves, and the stop itself is never a catch.
      expect(room.state.phase).not.toBe('PLAY');
      const res = JSON.parse(room.state.lastOutcome) as PlayResolution;
      expect(res.cause.kind).not.toBe('caught');
    }, 300000);

    it('WALL: the whale can throw the ball he gathered — his own blocker never pins the release (final-review fix)', async () => {
      // A held ball parks at the whale's hands, INSIDE his own armed blocker
      // capsule; a fresh flight released there pins against it (the physics-
      // level RED probe: 20 m/s → 1.8 m/s, stuck at ~0.4 m — see the
      // PhysicsModule own-throw regression test). Gates preserved: gather →
      // hold → throw → the ball ESCAPES cleanly. Migrated from the
      // ALWAYS_CATCH + whale-as-pitcher + aimed-grounder choreography: the
      // pinned seed parks the whale on his own play-1 roll corridor
      // (SEED_WALL_THROW_SPOT — Task-2 sweep; the live search verified that
      // on THIS seed the stopped ball is GATHERED by the whale himself, held,
      // thrown, escapes cleanly and forces a run-out).
      const room = await colyseus.createRoom<MatchState>('match', { seed: SEED_WALL_THROW });
      const { clientA, clientB } = await connectPair(room);
      await waitForPhase(room, 'DRAFT');
      await draftWithWhale(room, clientA, clientB);
      clientB.send('reposition', { id: 'whale', x: SEED_WALL_THROW_SPOT.x, z: SEED_WALL_THROW_SPOT.z });
      await waitForCondition(room, () => room.state.fielders.get('whale')?.z === SEED_WALL_THROW_SPOT.z);

      await startPlay(room, clientA, clientB);

      // Gather (hasBall flips true), then the delayed release (flips false).
      await waitForCondition(room, () => room.state.fielders.get('whale')?.hasBall === true, PLAY_TICK_BUDGET);
      await waitForCondition(
        room,
        () => room.state.fielders.get('whale')?.hasBall === false,
        ticksFor(GAME.THROW_RELEASE_DELAY_S + 3),
      );

      // The thrown ball must ESCAPE the whale: clear of him and still
      // travelling. A pinned release would sit at his feet at ~zero speed
      // until the play died at rest/timeout.
      let escaped = false;
      for (let i = 0; i < 90 && room.state.phase === 'PLAY' && !escaped; i += 1) {
        await room.waitForNextSimulationTick();
        const whale = room.state.fielders.get('whale');
        if (whale === undefined || !room.state.ballLive) continue;
        const d = Math.hypot(room.state.ball.x - whale.x, room.state.ball.z - whale.z);
        const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
        if (d > 3 && speed > 5) escaped = true;
      }
      expect(escaped).toBe(true);
    }, 300000);

    it('CLUTCH_SWING: carl’s final-innings drive matches the +3-power prediction, his innings-1 drive the plain one', async () => {
      // Migrated from the ALWAYS_CATCH + aimed-drive exit-speed comparison.
      // Two things changed shape:
      // (1) timing is a sampled draw now, so the old fixed ">34.2 m/s" gate
      //     would demand a LUCKY draw (|err| ≲ 0.04 s, ~14% per game) — pure
      //     flake bait, especially ~11 plays deep where real-time tick jitter
      //     makes the draw sequence non-reproducible run-to-run (observed in
      //     the Task-3 sweeps).
      // (2) The swing RollEvent broadcasts the draw itself, so the test can
      //     compute BOTH hypotheses for the very swing it measured:
      //     exitVelocity(8, t) (no bonus) v exitVelocity(11, t) (CLUTCH +3) —
      //     26% apart at ANY timing draw. The gate is therefore STRONGER, not
      //     weaker: the measured exit must sit inside the clutch prediction
      //     band and clear of the no-clutch band in the final innings, and the
      //     REVERSE in innings 1 (no bonus there). Only carl's contact itself
      //     is chancy (~1 in 4 misses), so up to three games (rematch keeps
      //     squads) bound the retry; each measured play is asserted in full.
      const room = await colyseus.createRoom<MatchState>('match', { seed: SEED_CLUTCH });
      const { clientA, clientB } = await connectPair(room);
      const rolls: RollEvent[] = [];
      clientA.onMessage('roll', (e: RollEvent) => rolls.push(e));
      const carl = getCharacter('carl');

      /** Prediction band for carl's measured exit given his swing roll: [low, high] for a power. */
      function band(power: number, swing: RollEvent): [number, number] {
        const absErr = swing.roll * CONST.GAME.AUTOPLAY_TIMING_NOISE_S; // roll = |err| / noise
        const t = timingFactor(absErr, swing.threshold); // threshold = the effective window
        // Pressure is not directly observable: bound with and without
        // pressureMult(nerve). Margins: −7% (sampling a few damped ticks after
        // the hit) / +2% (float slack).
        const low = exitVelocity(power, t * pressureMult(carl.stats.nerve)) * 0.93;
        const high = exitVelocity(power, t) * 1.02;
        return [low, high];
      }

      /**
       * Drive one play; if carl's swing connects, return the measured exit
       * speed and his swing roll, else null (missed — no measurement).
       */
      async function playAndMeasure(): Promise<{ exit: number; swing: RollEvent } | null> {
        // BROADCAST-RACE guard (check-run finding): the rolls collector is
        // client-side and broadcasts land ASYNCHRONOUSLY — under suite load a
        // previous play's rolls can still be in flight. Settle the backlog
        // BEFORE marking this play's start index (no new rolls fire between
        // plays), else a late-arriving earlier swing gets misattributed and
        // the bands are derived from the wrong draw.
        for (let i = 0; i < 10; i += 1) {
          const before = rolls.length;
          await room.waitForNextSimulationTick();
          if (rolls.length === before) break;
        }
        const rollStart = rolls.length;
        await startPlay(room, clientA, clientB);
        let exit = 0;
        let prevVz = 0;
        for (let i = 0; i < PLAY_TICK_BUDGET && room.state.phase === 'PLAY'; i += 1) {
          await room.waitForNextSimulationTick();
          // Sample validity (probe findings — each guard closed a REAL polluted
          // sample): the ONLY event that flips the polled ball from a strongly
          // negative vz (the incoming pitch) to a positive one is the bat
          // contact itself, so a genuine exit sample requires that transition
          // ACROSS CONSECUTIVE POLLS plus near-source position (z < 2 m).
          // Without the transition guard, a backstop's post-gather throw
          // (launched near z ≈ −3 towards a post, prev poll = held ball at
          // vz 0) or a lag-delayed read of the bounced, damped flight
          // masqueraded as the exit (observed 19.03 v ceiling 16.84 and 10.75
          // v floor 16.5 respectively). The guards can never reject a genuine
          // sample — the pitch always shows the poll loop several vz ≈ −20
          // frames first; a play whose sampling window was straddled entirely
          // by a lagging poll yields null and is RETRIED via the game loop,
          // never asserted.
          const vz = room.state.ball.vz;
          if (exit === 0 && prevVz < -5 && vz > 1 && room.state.ball.z < 2) {
            exit = Math.hypot(room.state.ball.vx, room.state.ball.vy, vz);
          }
          prevVz = vz;
        }
        // The connecting swing's roll may still be in flight when the play
        // ends (server-side phase read v client-side delivery): wait for it.
        let swing: RollEvent | undefined;
        for (let i = 0; i < 60 && swing === undefined; i += 1) {
          swing = rolls.slice(rollStart).filter((r) => r.contest === 'swing' && r.success).pop();
          if (swing === undefined) await room.waitForNextSimulationTick();
        }
        if (exit === 0 || swing === undefined) return null;
        return { exit, swing };
      }

      let clutchProven = false;
      for (let game = 0; game < 3 && !clutchProven; game += 1) {
        if (game > 0) {
          // Retry-path fix (Task-2 full-check run 2 caught this live): a null
          // final measurement leaves the room MID-game (PRE_PLAY, innings 2),
          // where rematch is rejected and the old bare waitForPhase hung. The
          // retry the measurement comments promise must first DRAIN the
          // current game to GAME_OVER — the only phase rematch is legal in.
          let drain = 0;
          while (room.state.phase !== 'GAME_OVER' && drain < 60) {
            await drivePlay(room, clientA, clientB);
            drain += 1;
          }
          expect(room.state.phase).toBe('GAME_OVER');
          clientA.send('rematch');
          await waitForPhase(room, 'INITIAL_POSITIONING');
        }
        // Innings 1, play 1: carl opens (fresh queue = pick order).
        await startPlay(room, clientA, clientB); // walks draft on game 0, no-op wait otherwise
        expect(room.state.inningsIndex).toBe(0);
        expect(room.state.currentBatterId).toBe('carl');
        const first = await playAndMeasure();
        if (first !== null) {
          // No bonus in innings 1: inside the plain band, clear of the clutch band.
          const [plainLow, plainHigh] = band(carl.stats.power, first.swing);
          const [clutchLow] = band(carl.stats.power + CONST.ABILITY.CLUTCH_POWER_BONUS, first.swing);
          expect(first.exit).toBeGreaterThanOrEqual(plainLow);
          expect(first.exit).toBeLessThanOrEqual(plainHigh);
          expect(first.exit).toBeLessThan(clutchLow);
        }

        // Drain to A's SECOND innings — the final pair, where isFinalInnings
        // holds. Innings length is variable (home re-queues), hence the cap.
        let plays = 0;
        while (room.state.inningsIndex < 2 && room.state.phase !== 'GAME_OVER' && plays < 40) {
          await drivePlay(room, clientA, clientB);
          plays += 1;
        }
        expect(room.state.inningsIndex).toBe(2);
        expect(room.state.battingSide).toBe('A');
        if (room.state.currentBatterId !== 'carl') {
          battingClient(room, clientA, clientB).send('setBatter', { id: 'carl' });
          await waitForCondition(room, () => room.state.currentBatterId === 'carl');
        }
        const final = await playAndMeasure();
        if (final !== null) {
          // CLUTCH's +3: inside the clutch band, clear of the plain band.
          const [clutchLow, clutchHigh] = band(carl.stats.power + CONST.ABILITY.CLUTCH_POWER_BONUS, final.swing);
          const [, plainHigh] = band(carl.stats.power, final.swing);
          expect(final.exit).toBeGreaterThanOrEqual(clutchLow);
          expect(final.exit).toBeLessThanOrEqual(clutchHigh);
          expect(final.exit).toBeGreaterThan(plainHigh);
          clutchProven = true;
        }
      }
      expect(clutchProven).toBe(true); // carl connected in SOME final innings within three games
    }, 2400000); // worst case now includes draining a retry game to GAME_OVER before its rematch
  });
});
