import { Room, type Client, type RoomException } from '@colyseus/core';
import {
  CHARACTERS,
  CONST,
  createRng,
  getCharacter,
  type FielderSetup,
  type MatchPhase,
  type PitchInput,
  type PlayOutcome,
  type RunDecisionInput,
  type SwingInput,
  type TeamSide,
} from '@carlquest/shared';
import { createPhysicsModule, type PhysicsModule } from '../modules/PhysicsModule';
import { resolvePitch } from '../modules/PitchModule';
import { resolveSwing } from '../modules/HitModule';
import { createFieldingModule, type FieldingEvent, type FieldingModule } from '../modules/FieldingModule';
import { createRunningModule, type RunnerView } from '../modules/RunningModule';
import { createRulesModule } from '../modules/RulesModule';
import { FielderSchema, MatchState, RunnerSchema } from './MatchState';

const { PHYSICS, GAME, FIELD } = CONST;

/**
 * M5 demo squads: BOTH sides are the full CHARACTERS table, batting order = table
 * order (a logged demo decision — the real draft lands in M7). Because the two
 * squads are the identical mirror roster, the fielding side (always the
 * NON-batting side) draws the SAME nine fielders whichever side bats, so the
 * fielding nine is fixed once here rather than recomputed per play.
 *
 * The fielding nine = the roster minus its nominal opener (CHARACTERS[0] = Carl),
 * first nine, mapped onto FIELDING_POSITIONS in slot order — so Kian (the
 * highest-pitch bowler) lands on slot 0, the bowling square. Slot-0 is the
 * pitcher for every play in the demo. Real squad selection is the M7 draft and
 * positioning is refined in M8.
 */
const OPENER_ID = CHARACTERS[0]?.id ?? 'carl';
const FIELDING_NINE: FielderSetup[] = CHARACTERS.filter((c) => c.id !== OPENER_ID)
  .slice(0, FIELD.FIELDING_POSITIONS.length)
  .map((character, i) => {
    const position = FIELD.FIELDING_POSITIONS[i];
    if (position === undefined) throw new RangeError(`no fielding slot ${i}`);
    return { character, position };
  });

const PITCHER_ID = FIELDING_NINE[0]?.character.id ?? 'kian';

type SwingMessage = SwingInput & { timing: number };

/** Terminating cause of a play plus the runner (if any) it puts out. */
interface Resolved {
  cause: PlayOutcome;
  outRunnerId: string | null;
}

/**
 * Room creation options. `rng`/`seed` are deterministic injection points used by
 * tests but are CLIENT-REACHABLE (joinOrCreate forwards the creating client's
 * options to onCreate), so each field is runtime-validated in onCreate; junk
 * falls through to the server's own wall-clock seed. The Date.now() fallback is
 * the one permissible wall-clock read (it seeds fielding randomness, not the
 * deterministic physics step). See CLAUDE.md §6.2/§6.4.
 */
interface MatchRoomOptions {
  rng?: () => number;
  seed?: number;
  /**
   * Client-generated 4-letter rendezvous code for room-code matchmaking.
   * `filterBy(['code'])` matches on CREATION options, so the server cannot
   * invent this itself — a server-picked code could never match a filtered
   * join. Absent = no code (tests / direct createRoom); present-but-malformed
   * is rejected in onCreate.
   */
  code?: string;
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

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Authoritative match room (M5): the real phase machine. RulesModule owns phase,
 * innings, outs and scoring; RunningModule owns the (multi) runners; FieldingModule
 * the fielders; PhysicsModule the ball. The room drives the tick loop, validates
 * every message against the current phase, and threads play outcomes through
 * running.settlePlay() → rules.resolvePlay() → schema/broadcast.
 */
export class MatchRoom extends Room<MatchState> {
  override maxClients = 2;

  private physics!: PhysicsModule;
  private fielding!: FieldingModule;
  private running!: ReturnType<typeof createRunningModule>;
  private rules!: ReturnType<typeof createRulesModule>;
  private simTime = 0;
  /** Sim-time when the live ball crossed the batting-square plane; null until it does. */
  private contactTime: number | null = null;
  private crossed = false;
  private swung = false;
  /** True from bat contact until the play ends — gates fielding/running/outcome resolution. */
  private contactMade = false;
  private liveSince = 0;
  private restSince: number | null = null;
  /**
   * Posts exposed to a run-out at the last run-out check (post-running.tick). The
   * M4 single-runner `lastExposedPost` generalised to a SET: when the exposure
   * set changes (a runner sets off / passes / halts, or a between-tick
   * runDecision opens a new window), the physics crossing latches are cleared so
   * only crossings DURING the current exposure window can run a runner out. See
   * checkRunOut and CLAUDE.md §6.2/§6.4 — both snapshot guards are load-bearing.
   */
  private lastExposedPosts: Set<number> = new Set();
  /** Per-side confirmations for the current INITIAL_POSITIONING / PRE_PLAY gate. */
  private confirmed: Record<TeamSide, boolean> = { A: false, B: false };
  private ready: Record<TeamSide, boolean> = { A: false, B: false };

  /** Which seat a message came from; null = not seated (defensive — reject). */
  private sideOf(client: Client): TeamSide | null {
    if (client.sessionId === this.state.sessionA) return 'A';
    if (client.sessionId === this.state.sessionB) return 'B';
    return null;
  }

  private fieldingSide(): TeamSide {
    return this.rules.view().battingSide === 'A' ? 'B' : 'A';
  }

  override async onCreate(options: MatchRoomOptions = {}): Promise<void> {
    // The room code is client-generated (filterBy matches CREATION options; a
    // server-invented code could never match a filtered join). Absent = no code
    // (tests / direct createRoom); present-but-malformed = reject the creation.
    if (options.code !== undefined && !/^[A-Z]{4}$/.test(String(options.code))) {
      throw new Error(`invalid room code: ${String(options.code)}`);
    }

    this.setState(new MatchState());
    if (options.code !== undefined) this.state.roomCode = options.code;
    this.physics = await createPhysicsModule();

    // Mirror-roster demo squads (both sides = full table, batting order = table order).
    const squadA = [...CHARACTERS];
    const squadB = [...CHARACTERS];
    this.rules = createRulesModule({ squadA, squadB });

    // Join options are wire data — validate before use (a non-function rng would
    // throw in the sim interval; a non-finite seed would poison createRng).
    const seed = isFiniteNumber(options.seed) ? options.seed : Date.now();
    const rng = typeof options.rng === 'function' ? options.rng : createRng(seed);
    this.fielding = createFieldingModule(FIELDING_NINE, {
      rng,
      hasBounced: () => this.physics.hasBounced(),
      applyThrow: (params) => this.physics.applyPitch(params),
      holdBallAt: (pos) => this.physics.spawnBall(pos),
      pressure: () => this.rules.pressure(this.runnersOnPosts()),
    });
    this.running = createRunningModule();

    this.state.currentPitcherId = PITCHER_ID;
    this.syncRulesView();
    this.syncFielders();
    this.syncRunners();

    this.onMessage('pitch', (client, message) => this.handlePitch(client, message));
    this.onMessage('swing', (client, message) => this.handleSwing(client, message));
    this.onMessage('runDecision', (client, message) => this.handleRunDecision(client, message));
    this.onMessage('confirmPositioning', (client) => this.handleConfirmPositioning(client));
    this.onMessage('readyForPlay', (client) => this.handleReadyForPlay(client));
    this.onMessage('rematch', (client) => this.handleRematch(client));

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / 60);
  }

  override onJoin(client: Client): void {
    console.log(`client ${client.sessionId} joined`);
    if (this.state.sessionA === '') {
      this.state.sessionA = client.sessionId;
      this.state.connectedA = true;
    } else if (this.state.sessionB === '') {
      this.state.sessionB = client.sessionId;
      this.state.connectedB = true;
      // Both seats filled: leave LOBBY. DRAFT stays auto-skipped with the
      // mirror-roster demo squads until M7.
      this.rules.bothConnected();
      this.rules.completeDraft();
    }
    this.syncRulesView();
  }

  override onLeave(client: Client): void {
    console.log(`client ${client.sessionId} left`);
    // Pre-game leave frees the seat; mid-game disconnect handling lands in Task 3.
    if (this.phase() !== 'LOBBY') return;
    if (this.state.sessionA === client.sessionId) {
      this.state.sessionA = '';
      this.state.connectedA = false;
    } else if (this.state.sessionB === client.sessionId) {
      this.state.sessionB = '';
      this.state.connectedB = false;
    }
  }

  override onDispose(): void {
    this.physics.dispose();
  }

  /** Last line of defence: log and swallow any uncaught throw in a room callback. */
  override onUncaughtException(
    error: RoomException<this>,
    methodName: 'onCreate' | 'onAuth' | 'onJoin' | 'onLeave' | 'onDispose' | 'onMessage' | 'setSimulationInterval' | 'setInterval' | 'setTimeout',
  ): void {
    console.error(`[MatchRoom] uncaught exception in ${methodName}:`, error);
  }

  private phase(): MatchPhase {
    return this.rules.view().phase;
  }

  /** Record and broadcast a structured rejection { message, phase, reason }. */
  private reject(message: string, reason: string): void {
    const payload = { message, phase: this.phase(), reason };
    this.state.lastRejection = JSON.stringify(payload);
    this.broadcast('rejected', payload);
  }

  /** Runners currently standing on a real post (1-4) — the pressure/threshold count. */
  private runnersOnPosts(): number {
    return this.running.runners().filter((r) => r.atPost !== null && r.atPost >= 1).length;
  }

  /** The current play's batter-runner view (the one flagged ownHitPlay), if any. */
  private batterRunnerView(): RunnerView | undefined {
    return this.running.runners().find((r) => r.ownHitPlay);
  }

  private batterRunnerId(): string {
    return this.batterRunnerView()?.id ?? this.rules.view().currentBatterId ?? '';
  }

  // ---- Message handlers ------------------------------------------------------

  private handlePitch(client: Client, message: unknown): void {
    if (this.phase() !== 'PLAY') {
      this.reject('pitch', `pitch only allowed in PLAY (phase ${this.phase()})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject('pitch', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<PitchInput>;
    if (this.state.ballLive || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.reject('pitch', 'ball already live or malformed input');
      return;
    }
    const pitcher = getCharacter(this.state.currentPitcherId);
    const params = resolvePitch(pitcher.stats, { aim: m.aim, spinInput: m.spinInput });
    this.physics.applyPitch(params);
    this.state.ballLive = true;
    this.contactMade = false;
    this.contactTime = null;
    this.crossed = false;
    this.swung = false;
    this.liveSince = this.simTime;
    this.restSince = null;
  }

  private handleSwing(client: Client, message: unknown): void {
    if (this.phase() !== 'PLAY') {
      this.reject('swing', `swing only allowed in PLAY (phase ${this.phase()})`);
      return;
    }
    if (this.sideOf(client) !== this.rules.view().battingSide) {
      this.reject('swing', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<SwingMessage>;
    // The client 'timing' field is accepted but ignored; the server's own
    // sim-time is authoritative (M3 decision, latency comp revisited in M6).
    if (!this.state.ballLive || this.swung || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.reject('swing', 'no live pitch, already swung, or malformed input');
      return;
    }
    const error = this.timingErrorNow();
    if (error === null) {
      this.reject('swing', 'ball never reaches the batter');
      return;
    }
    this.swung = true;
    const batterId = this.rules.view().currentBatterId;
    if (batterId === null) {
      this.reject('swing', 'no batter up');
      return;
    }
    const batter = getCharacter(batterId);
    const pressure = this.rules.pressure(this.runnersOnPosts());
    const result = resolveSwing(batter.stats, { aim: m.aim, spinInput: m.spinInput }, error, 1, pressure);
    if (!result.contact) {
      // A legal swing that missed: not a rejection. The ball flies on and the
      // play ends at rest/timeout with no contact (respawn, same batter re-pitches).
      return;
    }
    this.physics.applyHit(result.params);
    this.running.startRun(batter);
    this.contactMade = true;
    // applyHit cleared the crossing latches; seed lastExposedPosts with the new
    // runner's opening exposure (post 1) so the first checkRunOut does not treat
    // it as an exposure CHANGE and discard a legitimate first-tick crossing.
    this.lastExposedPosts = new Set(this.running.exposures().map((e) => e.post));
  }

  private handleRunDecision(client: Client, message: unknown): void {
    if (this.phase() !== 'PLAY') {
      this.reject('runDecision', `runDecision only allowed in PLAY (phase ${this.phase()})`);
      return;
    }
    if (this.sideOf(client) !== this.rules.view().battingSide) {
      this.reject('runDecision', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<RunDecisionInput>;
    const hasLiveRunner = this.contactMade && this.running.runners().some((r) => !r.out && !r.home);
    if (!this.state.ballLive || !hasLiveRunner || typeof m.go !== 'boolean') {
      this.reject('runDecision', 'no live runner or malformed input');
      return;
    }
    // Shared stop/go applies to every live runner (RunningModule; user decision 2).
    this.running.setDecision(m.go);
  }

  private handleConfirmPositioning(client: Client): void {
    const side = this.sideOf(client);
    if (side === null) {
      this.reject('confirmPositioning', 'wrongRole');
      return;
    }
    if (this.phase() !== 'INITIAL_POSITIONING') {
      this.reject('confirmPositioning', `only allowed in INITIAL_POSITIONING (phase ${this.phase()})`);
      return;
    }
    this.confirmed[side] = true; // duplicate confirm is idempotent, not a rejection
    if (this.confirmed.A && this.confirmed.B) {
      this.rules.confirmPositioning();
      this.confirmed = { A: false, B: false };
      this.syncRulesView();
    }
  }

  private handleReadyForPlay(client: Client): void {
    const side = this.sideOf(client);
    if (side === null) {
      this.reject('readyForPlay', 'wrongRole');
      return;
    }
    if (this.phase() !== 'PRE_PLAY') {
      this.reject('readyForPlay', `only allowed in PRE_PLAY (phase ${this.phase()})`);
      return;
    }
    this.ready[side] = true;
    if (this.ready.A && this.ready.B) {
      this.rules.readyForPlay();
      this.ready = { A: false, B: false };
      this.syncRulesView();
    }
  }

  private handleRematch(client: Client): void {
    if (this.sideOf(client) === null) {
      this.reject('rematch', 'wrongRole');
      return;
    }
    if (!this.rules.rematch()) {
      this.reject('rematch', `only allowed in GAME_OVER (phase ${this.phase()})`);
      return;
    }
    // Fresh match: clear runners (innings/rematch is the only running.reset seam),
    // fielders back to slots, ball parked, all latches cleared.
    this.running.reset();
    this.fielding.reset();
    this.physics.spawnBall();
    this.state.ballLive = false;
    this.contactMade = false;
    this.restSince = null;
    this.lastExposedPosts = new Set();
    this.state.lastOutcome = '';
    this.confirmed = { A: false, B: false };
    this.ready = { A: false, B: false };
    this.syncRulesView();
    this.syncRunners();
    this.syncFielders();
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

  // ---- Simulation tick -------------------------------------------------------

  private tick(deltaMs: number): void {
    // Clamp to avoid a spiral-of-death catch-up burst after an event-loop stall.
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

    this.syncBall();

    if (this.contactMade) {
      // Pre-fielding snapshot of the exposed posts' crossing latches: a same-tick
      // gather (holdBallAt → placeBall) clears the latches, so read them BEFORE
      // fielding. Honour only posts continuously exposed since the last check
      // (in BOTH pre-tick exposures AND lastExposedPosts) — a between-tick
      // runDecision opening a new window over a stale latch must not count.
      const preExposures = this.running.exposures();
      const preExposedPosts = new Set(preExposures.map((e) => e.post));
      const crossedSnapshot = new Map<number, boolean>();
      for (const post of preExposedPosts) {
        if (this.lastExposedPosts.has(post)) {
          crossedSnapshot.set(post, this.physics.wasBallAtPost(post - 1));
        }
      }

      const fieldingEvent = this.fielding.tick(dt, state, this.state.ballLive, this.primaryExposure(preExposures));
      this.running.tick(dt);

      const atRest = this.updateRestTracking(state);
      const resolved = this.resolveOutcome(fieldingEvent, atRest, crossedSnapshot);
      if (resolved !== null) {
        this.endPlay(resolved);
      } else {
        this.syncRunners();
        this.syncFielders();
      }
    } else if (this.updateRestTracking(state)) {
      // No contact this play (un-hit pitch or a missed swing): quietly respawn
      // and stay in PLAY so the batter can re-pitch — no play resolution.
      this.state.ballLive = false;
      this.physics.spawnBall();
      this.restSince = null;
    }
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

  /** Feed the fielder AI ONE threatened post: the most advanced exposed runner's target (deterministic). */
  private primaryExposure(exposures: { runnerId: string; post: number }[]): number | null {
    let best: number | null = null;
    for (const e of exposures) if (best === null || e.post > best) best = e.post;
    return best;
  }

  /**
   * Per-runner run-out. exposures() gives every mid-segment runner's target post.
   * For each exposed post the ball is "at" it when: a pre-fielding snapshot caught
   * a same-tick crossing on a continuously-exposed post; OR the sensor was
   * touched this segment (wasBallAtPost, event-accurate per substep); OR the ball
   * currently intersects it; OR the holder stands within range of it. First hit
   * wins. When the exposure SET changes, latches are cleared so stale crossings
   * (from before the window) never count (CLAUDE.md §6.4).
   */
  private checkRunOut(crossedSnapshot: Map<number, boolean>): { runnerId: string; post: number } | null {
    const exposures = this.running.exposures();
    const currentPosts = new Set(exposures.map((e) => e.post));
    if (!setsEqual(currentPosts, this.lastExposedPosts)) {
      this.physics.clearPostCrossings();
      this.lastExposedPosts = currentPosts;
    }
    for (const { runnerId, post } of exposures) {
      const idx = post - 1; // physics posts are 0-based; posts 1-4 in the running/schema domain
      if (crossedSnapshot.get(post) === true) return { runnerId, post };
      if (this.physics.wasBallAtPost(idx)) return { runnerId, post };
      if (this.physics.isBallAtPost(idx)) return { runnerId, post };
      if (this.holderNearPost(post)) return { runnerId, post };
    }
    return null;
  }

  /** The current ball holder is standing within a post's run-out sensor radius. */
  private holderNearPost(post: number): boolean {
    const holderId = this.fielding.holderId();
    if (holderId === null) return false;
    const holder = this.fielding.getFielders().find((f) => f.id === holderId);
    if (holder === undefined) return false;
    const p = FIELD.POSTS[post - 1];
    if (p === undefined) return false;
    return Math.hypot(holder.x - p.x, holder.z - p.z) <= FIELD.POST_SENSOR_RADIUS;
  }

  /** First-outcome-wins resolution, in priority order: caught, runOut, then rest/timeout settle. */
  private resolveOutcome(
    fieldingEvent: FieldingEvent | null,
    atRest: boolean,
    crossedSnapshot: Map<number, boolean>,
  ): Resolved | null {
    if (fieldingEvent !== null && fieldingEvent.kind === 'caught') {
      // The batter-runner is caught out; the fielder is cause.by.
      return { cause: { kind: 'caught', by: fieldingEvent.by }, outRunnerId: this.batterRunnerId() };
    }
    const runOut = this.checkRunOut(crossedSnapshot);
    if (runOut !== null) {
      return {
        cause: { kind: 'runOut', atPost: runOut.post, runnerId: runOut.runnerId },
        outRunnerId: runOut.runnerId,
      };
    }
    if (atRest) {
      return { cause: this.settleCause(), outRunnerId: null };
    }
    return null;
  }

  /** The reported PlayOutcome for a play that ends at rest/timeout (from the batter-runner's position). */
  private settleCause(): PlayOutcome {
    const b = this.batterRunnerView();
    if (b?.home === true) return { kind: 'rounder' };
    const atPost = b === undefined ? 0 : (b.atPost ?? (b.targetPost !== null ? b.targetPost - 1 : 0));
    const runnerId = b?.id ?? this.rules.view().currentBatterId ?? '';
    return { kind: 'safe', atPost, runnerId };
  }

  /**
   * Settle the play: mark the out runner (caught batter / run-out) so settlePlay
   * removes them, gather per-runner facts, then let RulesModule resolve scoring,
   * outs, batter rotation and phase. Broadcast/sync the resolution. running.reset()
   * is called ONLY when the innings context changes (innings switch, tiebreak, or
   * game over) — otherwise parked survivors persist into the next play.
   */
  private endPlay(resolved: Resolved): void {
    if (resolved.outRunnerId !== null && resolved.outRunnerId !== '') {
      this.running.markOut(resolved.outRunnerId);
    }
    const facts = this.running.settlePlay();
    const prevInnings = this.rules.view().inningsIndex;
    const resolution = this.rules.resolvePlay(resolved.cause, facts);

    this.state.ballLive = false;
    this.contactMade = false;
    this.physics.spawnBall();
    this.fielding.reset();
    this.restSince = null;
    this.lastExposedPosts = new Set();
    this.confirmed = { A: false, B: false };
    this.ready = { A: false, B: false };

    if (resolution === null) {
      // Defensive: resolvePlay only returns null out of PLAY / with no batter,
      // neither of which should reach here. Log, clear runners, and recover.
      console.error('[MatchRoom] resolvePlay returned null unexpectedly');
      this.running.reset();
      this.syncRulesView();
      this.syncRunners();
      this.syncFielders();
      return;
    }

    this.state.lastOutcome = JSON.stringify(resolution);
    this.broadcast('playOutcome', resolution);

    const v = this.rules.view();
    if (v.phase === 'GAME_OVER' || v.inningsIndex !== prevInnings || v.tiebreak) {
      this.running.reset(); // innings switch / tiebreak / game over: no parked carry-over
    }
    this.syncRulesView();
    this.syncRunners();
    this.syncFielders();
  }

  // ---- Schema sync -----------------------------------------------------------

  private syncBall(): void {
    const state = this.physics.getBallState();
    this.state.ball.x = state.position.x;
    this.state.ball.y = state.position.y;
    this.state.ball.z = state.position.z;
    this.state.ball.vx = state.velocity.x;
    this.state.ball.vy = state.velocity.y;
    this.state.ball.vz = state.velocity.z;
    this.state.ball.wx = state.angularVelocity.x;
    this.state.ball.wy = state.angularVelocity.y;
    this.state.ball.wz = state.angularVelocity.z;
  }

  private syncRulesView(): void {
    const v = this.rules.view();
    this.state.phase = v.phase;
    this.state.scoreHalvesA = v.scoreHalves.A;
    this.state.scoreHalvesB = v.scoreHalves.B;
    this.state.inningsIndex = v.inningsIndex;
    this.state.outs = v.outs;
    this.state.battingSide = v.battingSide;
    this.state.currentBatterId = v.currentBatterId ?? '';
    this.state.tiebreak = v.tiebreak;
    this.state.winner = v.winner ?? '';
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

  private syncRunners(): void {
    const seen = new Set<string>();
    for (const view of this.running.runners()) {
      seen.add(view.id);
      let schema = this.state.runners.get(view.id);
      if (schema === undefined) {
        schema = new RunnerSchema();
        schema.id = view.id;
        this.state.runners.set(view.id, schema);
      }
      schema.x = view.x;
      schema.z = view.z;
      schema.atPost = view.atPost ?? -1;
      schema.running = view.targetPost !== null;
      schema.out = view.out;
    }
    for (const key of [...this.state.runners.keys()]) {
      if (!seen.has(key)) this.state.runners.delete(key);
    }
  }
}
