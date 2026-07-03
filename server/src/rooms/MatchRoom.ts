import { Room, type Client, type RoomException } from '@colyseus/core';
import {
  CHARACTERS,
  CONST,
  createRng,
  getCharacter,
  type FielderSetup,
  type PitchInput,
  type PlayOutcome,
  type RunDecisionInput,
  type SwingInput,
} from '@carlquest/shared';
import { createPhysicsModule, type PhysicsModule } from '../modules/PhysicsModule';
import { resolvePitch } from '../modules/PitchModule';
import { resolveSwing } from '../modules/HitModule';
import { createFieldingModule, type FieldingEvent, type FieldingModule } from '../modules/FieldingModule';
import { createRunningModule } from '../modules/RunningModule';
import { FielderSchema, MatchState } from './MatchState';

const { PHYSICS, GAME, FIELD } = CONST;

/** Demo cast for the M3+ single-player loop; the draft replaces this in Milestone 7. */
const DEMO_PITCHER = getCharacter('kian');
const DEMO_BATTER = getCharacter('carl');

/**
 * Demo fielding side (M4): the first 9 roster entries excluding the demo
 * batter, in table order, mapped onto FIELDING_POSITIONS in slot order —
 * Kian (first non-batter entry) lands on slot 0, the bowler. Real squad
 * selection is the M7 draft; positioning is refined in M8.
 */
const FIELDING_SIDE: FielderSetup[] = CHARACTERS.filter((c) => c.id !== DEMO_BATTER.id)
  .slice(0, FIELD.FIELDING_POSITIONS.length)
  .map((character, i) => {
    const position = FIELD.FIELDING_POSITIONS[i];
    if (position === undefined) throw new RangeError(`no fielding slot ${i}`);
    return { character, position };
  });

type SwingMessage = SwingInput & { timing: number };

/**
 * Room creation options. `rng`/`seed` are test-only deterministic injection
 * points (plan §Global Constraints: no hunting for magic seeds) — production
 * always falls through to `seed ?? Date.now()`, the one permissible
 * wall-clock read (it parameterises fielding randomness, not the physics
 * simulation itself — logged in CLAUDE.md §6.2).
 */
interface MatchRoomOptions {
  rng?: () => number;
  seed?: number;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isVec3(v: unknown): v is { x: number; y: number; z: number } {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return isFiniteNumber(c.x) && isFiniteNumber(c.y) && isFiniteNumber(c.z);
}

/**
 * Coerce an arbitrary message payload to a safe object before property access.
 * A client can send a message with no payload (`room.send('pitch')`, payload
 * `undefined`) or an explicit `null` payload; without this guard `m.aim` throws
 * a TypeError ahead of the isVec3 validation below.
 */
function asRecord(message: unknown): Record<string, unknown> {
  return typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
}

/** Authoritative match room. M3: single-player pitch→swing demo loop. */
export class MatchRoom extends Room<MatchState> {
  override maxClients = 2;

  private physics!: PhysicsModule;
  private fielding!: FieldingModule;
  private running!: ReturnType<typeof createRunningModule>;
  private simTime = 0;
  /** Sim-time when the live ball crossed the batting-square plane; null until it does. */
  private contactTime: number | null = null;
  private crossed = false;
  private swung = false;
  private liveSince = 0;
  private restSince: number | null = null;
  /**
   * The exposedPost() value at the last run-out check. When exposure changes
   * (runner sets off from a post, passes one, halts, or is exposed for the
   * first time), the physics crossing latches are cleared so that only
   * crossings DURING the current exposure window can trigger a run-out — a
   * crossing that predates the exposure (e.g. the hit flew through post 2
   * early in flight, and the runner only later set off for post 2) must not
   * count. See checkRunOut and CLAUDE.md §6.2 (task-5 fix round 2).
   */
  private lastExposedPost: number | null = null;

  override async onCreate(options: MatchRoomOptions = {}): Promise<void> {
    this.setState(new MatchState());
    this.physics = await createPhysicsModule();

    const seed = options.seed ?? Date.now();
    const rng = options.rng ?? createRng(seed);
    this.fielding = createFieldingModule(FIELDING_SIDE, {
      rng,
      hasBounced: () => this.physics.hasBounced(),
      applyThrow: (params) => this.physics.applyPitch(params),
      holdBallAt: (pos) => this.physics.spawnBall(pos),
    });
    this.running = createRunningModule();
    this.syncFielders();
    this.syncRunner();

    this.onMessage('pitch', (client, message) => this.handlePitch(client, message));
    this.onMessage('swing', (client, message) => this.handleSwing(client, message));
    this.onMessage('runDecision', (client, message) => this.handleRunDecision(client, message));

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / 60);
  }

  override onJoin(client: Client): void {
    console.log(`client ${client.sessionId} joined`);
  }

  override onLeave(client: Client): void {
    console.log(`client ${client.sessionId} left`);
  }

  override onDispose(): void {
    this.physics.dispose();
  }

  /**
   * Belt-and-braces: log and swallow any exception the framework catches from a
   * lifecycle/message handler instead of letting it escape as a process-level
   * crash. The isVec3/isFiniteNumber validation above should make this
   * unreachable for pitch/swing, but this is the last line of defence for any
   * other uncaught throw in a room callback.
   */
  override onUncaughtException(
    error: RoomException<this>,
    methodName: 'onCreate' | 'onAuth' | 'onJoin' | 'onLeave' | 'onDispose' | 'onMessage' | 'setSimulationInterval' | 'setInterval' | 'setTimeout',
  ): void {
    console.error(`[MatchRoom] uncaught exception in ${methodName}:`, error);
  }

  private handlePitch(_client: Client, message: unknown): void {
    const m = asRecord(message) as Partial<PitchInput>;
    if (this.state.ballLive || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.state.demoLog = 'pitch rejected (ball live or malformed input)';
      return;
    }
    const params = resolvePitch(DEMO_PITCHER.stats, { aim: m.aim, spinInput: m.spinInput });
    this.physics.applyPitch(params);
    this.state.ballLive = true;
    this.state.demoLog = 'pitch away';
    this.contactTime = null;
    this.crossed = false;
    this.swung = false;
    this.liveSince = this.simTime;
    this.restSince = null;
  }

  private handleSwing(_client: Client, message: unknown): void {
    const m = asRecord(message) as Partial<SwingMessage>;
    // M3 decision: the client 'timing' field is accepted but ignored; the server's
    // own sim-time is authoritative. Revisit for latency compensation in Milestone 6.
    if (!this.state.ballLive || this.swung || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.state.demoLog = 'swing rejected (no live pitch, already swung, or malformed input)';
      return;
    }
    const error = this.timingErrorNow();
    if (error === null) {
      this.state.demoLog = 'swing rejected (ball never reaches the batter)';
      return;
    }
    this.swung = true;
    const result = resolveSwing(DEMO_BATTER.stats, { aim: m.aim, spinInput: m.spinInput }, error);
    if (!result.contact) {
      this.state.demoLog = `swing missed (timing error ${error.toFixed(3)} s)`;
      return;
    }
    this.physics.applyHit(result.params);
    this.running.startRun(DEMO_BATTER);
    // The first exposure window (post 1) opens here, and applyHit has just
    // cleared the crossing latches — record it now so the first checkRunOut
    // does not treat it as an exposure CHANGE and discard a legitimate
    // crossing from the very first tick of flight.
    this.lastExposedPost = this.running.exposedPost();
    this.state.demoLog = `hit! timing factor ${result.timingFactor.toFixed(2)}`;
  }

  private handleRunDecision(_client: Client, message: unknown): void {
    const m = asRecord(message) as Partial<RunDecisionInput>;
    const runner = this.running.runner();
    if (!this.state.ballLive || runner === null || runner.out || typeof m.go !== 'boolean') {
      this.state.demoLog = 'runDecision rejected (no live runner or malformed input)';
      return;
    }
    this.running.setDecision(m.go);
    this.state.demoLog = m.go ? 'runner: go' : 'runner: stop';
  }

  /** Signed swing-timing error: positive = late, negative = early; null if no contact possible. */
  private timingErrorNow(): number | null {
    if (this.contactTime !== null) return this.simTime - this.contactTime;
    const ball = this.physics.getBallState();
    const dz = ball.position.z - FIELD.BATTING_SQUARE.z;
    if (ball.velocity.z >= 0) return null; // moving away — will never cross
    const timeToPlane = dz / -ball.velocity.z;
    return -timeToPlane; // early by the projected time remaining
  }

  private tick(deltaMs: number): void {
    // Clamp to avoid a spiral-of-death catch-up burst after an event-loop stall (§6.4 M2 item).
    const dt = Math.min(deltaMs / 1000, PHYSICS.SIM_MAX_CATCHUP);
    this.simTime += dt;
    if (!this.state.ballLive) return;

    const beforePos = this.physics.getBallState().position;
    this.physics.step(dt);
    const state = this.physics.getBallState();

    // Record the moment the ball first crosses the batting-square plane (ideal contact).
    if (!this.crossed && beforePos.z > FIELD.BATTING_SQUARE.z && state.position.z <= FIELD.BATTING_SQUARE.z) {
      this.crossed = true;
      this.contactTime = this.simTime;
    }

    this.state.ball.x = state.position.x;
    this.state.ball.y = state.position.y;
    this.state.ball.z = state.position.z;
    this.state.ball.vx = state.velocity.x;
    this.state.ball.vy = state.velocity.y;
    this.state.ball.vz = state.velocity.z;
    this.state.ball.wx = state.angularVelocity.x;
    this.state.ball.wy = state.angularVelocity.y;
    this.state.ball.wz = state.angularVelocity.z;

    // Fielding/running/outcome resolution only engage once a hit has started
    // a run — before that (a pitch still in flight, or a swing that missed),
    // there is nothing yet to field: without this gate, a fielder standing at
    // the release point (the bowler) could roll a "catch" on their own
    // still-live pitch before the batter ever swings.
    if (this.running.runner() !== null) {
      // Fielding sees the runner's pre-tick target (this tick's chase/cover
      // decision); the run-out check below re-reads exposedPost() AFTER
      // running.tick, per plan order.
      const fieldingEvent = this.fielding.tick(dt, state, this.state.ballLive, this.running.exposedPost());
      this.running.tick(dt);

      const atRestOrTimedOut = this.updateRestTracking(state);
      const outcome = this.resolveOutcome(fieldingEvent, atRestOrTimedOut);
      if (outcome !== null) {
        this.endPlay(outcome);
      }
    } else if (this.updateRestTracking(state)) {
      // M3 behaviour preserved: nobody swung (or swung and missed) — quietly
      // respawn with no scoring outcome to report.
      this.state.ballLive = false;
      this.state.demoLog = 'play over (rest/timeout) — press P to pitch';
      this.physics.spawnBall();
    }

    this.syncFielders();
    this.syncRunner();
  }

  /** Updates the rest/timeout latch from the current ball state; returns whether the play should end for that reason. */
  private updateRestTracking(state: { velocity: { x: number; y: number; z: number } }): boolean {
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    if (speed < GAME.BALL_REST_SPEED) {
      this.restSince ??= this.simTime;
    } else {
      this.restSince = null;
    }
    const timedOut = this.simTime - this.liveSince > GAME.PLAY_TIMEOUT_S;
    const atRest = this.restSince !== null && this.simTime - this.restSince > GAME.BALL_REST_TIME_S;
    return timedOut || atRest;
  }

  /**
   * Run-out per plan: the ball has touched the exposed post's run-out sensor at
   * any point this play segment (event-accurate via physics.wasBallAtPost —
   * latched per substep, so a fast fly-through between ticks is never lost, per
   * CLAUDE.md §6.4) OR the ball's current holder is standing within range of it.
   */
  private checkRunOut(): number | null {
    const exposed = this.running.exposedPost();
    if (exposed !== this.lastExposedPost) {
      // Exposure changed since the last check (runner set off from a post,
      // passed one, or halted): crossings latched before this exposure began
      // must not count — the rule is "ball at the exposed post WHILE exposed",
      // not "ball has ever touched that post this play segment".
      this.physics.clearPostCrossings();
      this.lastExposedPost = exposed;
    }
    if (exposed === null) return null;
    const postIndex = exposed - 1; // physics posts are 0-based; posts 1-4 in the running/schema domain
    if (this.physics.wasBallAtPost(postIndex)) return exposed;
    // The event latch fires on sensor ENTRY; a ball already resting inside the
    // sensor when this exposure window opened re-fires no event (and the clear
    // above just discarded its entry), so also poll the current intersection.
    if (this.physics.isBallAtPost(postIndex)) return exposed;
    const holderId = this.fielding.holderId();
    if (holderId === null) return null;
    const holder = this.fielding.getFielders().find((f) => f.id === holderId);
    if (holder === undefined) return null;
    const post = FIELD.POSTS[postIndex];
    if (post === undefined) return null;
    const distance = Math.hypot(holder.x - post.x, holder.z - post.z);
    return distance <= FIELD.POST_SENSOR_RADIUS ? exposed : null;
  }

  /** First-outcome-wins resolution, in plan priority order: caught, runOut, rounder, safe. */
  private resolveOutcome(fieldingEvent: FieldingEvent | null, atRestOrTimedOut: boolean): PlayOutcome | null {
    if (fieldingEvent !== null && fieldingEvent.kind === 'caught') {
      return { kind: 'caught', by: fieldingEvent.by };
    }
    const runOutPost = this.checkRunOut();
    if (runOutPost !== null) {
      return { kind: 'runOut', atPost: runOutPost };
    }
    const runner = this.running.runner();
    if (runner !== null) {
      if (runner.home) return { kind: 'rounder' };
      if (atRestOrTimedOut) {
        // Mid-segment at play end = safe at the previous post (M4 simplification, logged in CLAUDE.md §6.2).
        // A live, non-home runner always has EITHER targetPost (mid-segment) OR
        // atPost (halted) non-null — RunningModule never leaves both null while
        // running (startRun sets targetPost; arrival sets one or the other), and
        // the only null/null state is `out`, which is resolved as a run-out
        // above. So the final `: 0` branch is unreachable; it is a defensive
        // default that keeps atPost a valid number rather than undefined/NaN if
        // that invariant is ever changed.
        const atPost = runner.atPost ?? (runner.targetPost !== null ? runner.targetPost - 1 : 0);
        return { kind: 'safe', atPost };
      }
    }
    return null;
  }

  private endPlay(outcome: PlayOutcome): void {
    this.state.lastOutcome = JSON.stringify(outcome);
    this.broadcast('playOutcome', outcome);
    this.state.ballLive = false;
    this.state.demoLog = `play over: ${outcome.kind}`;
    this.physics.spawnBall();
    this.fielding.reset();
    this.running.reset();
    this.restSince = null;
    this.lastExposedPost = null;
  }

  private syncFielders(): void {
    for (const view of this.fielding.getFielders()) {
      let schema = this.state.fielders.get(view.id);
      if (schema === undefined) {
        schema = new FielderSchema();
        schema.id = view.id;
        this.state.fielders.set(view.id, schema);
      }
      schema.x = view.x;
      schema.z = view.z;
      schema.hasBall = view.hasBall;
      schema.stamina = view.stamina;
    }
  }

  private syncRunner(): void {
    const view = this.running.runner();
    if (view === null) {
      this.state.runner.id = '';
      this.state.runner.x = 0;
      this.state.runner.z = 0;
      this.state.runner.atPost = -1;
      this.state.runner.running = false;
      this.state.runner.out = false;
      return;
    }
    this.state.runner.id = view.id;
    this.state.runner.x = view.x;
    this.state.runner.z = view.z;
    this.state.runner.atPost = view.atPost ?? -1;
    this.state.runner.running = view.targetPost !== null;
    this.state.runner.out = view.out;
  }
}
