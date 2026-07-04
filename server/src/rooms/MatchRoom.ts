import { Room, type Client, type RoomException } from '@colyseus/core';
import {
  CHARACTERS,
  CONST,
  createRng,
  getCharacter,
  type Character,
  type DraftPickInput,
  type FielderSetup,
  type MatchPhase,
  type PitchInput,
  type PlayOutcome,
  type RepositionInput,
  type RunDecisionInput,
  type SetBatterInput,
  type SetPitcherInput,
  type SubstituteInput,
  type SwingInput,
  type TeamSide,
} from '@carlquest/shared';
import { createPositioningModule } from '../modules/PositioningModule';
import { createPhysicsModule, type PhysicsModule } from '../modules/PhysicsModule';
import { resolvePitch } from '../modules/PitchModule';
import { resolveSwing } from '../modules/HitModule';
import { createFieldingModule, type FieldingDeps, type FieldingEvent, type FieldingModule } from '../modules/FieldingModule';
import { createRunningModule, type RunnerView } from '../modules/RunningModule';
import { createRulesModule } from '../modules/RulesModule';
import { createDraftModule, picksEach } from '../modules/DraftModule';
import { FielderSchema, MatchState, RunnerSchema } from './MatchState';

const { PHYSICS, GAME, FIELD } = CONST;

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
  /**
   * Test-only override of the mid-game reconnect grace window (seconds).
   * Wire-reachable like `seed`/`rng` (joinOrCreate forwards creation options),
   * so runtime-validated the same way; junk/absent falls back to
   * CONST.GAME.RECONNECT_GRACE_S.
   */
  reconnectGraceS?: number;
  /**
   * Test-only override of the on-field slot count, so small drafted squads can
   * still exercise a real bench. Wire-reachable like `seed` (joinOrCreate
   * forwards creation options), so runtime-validated the same way: a positive
   * integer ≤ FIELDING_POSITIONS.length; junk/absent falls back to the full
   * slot count.
   */
  fieldSlotsOverride?: number;
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
  private draft!: ReturnType<typeof createDraftModule>;
  /** Drafted squads (pick order), set when the draft completes; empty before. */
  private squads: Record<TeamSide, Character[]> = { A: [], B: [] };
  /** The nominated bowler for the CURRENT fielding side (default: best pitch stat). */
  private pitcherId = '';
  /** Fielding side the current FieldingModule was built for (pitcher resets to default on change). */
  private builtFieldingSide: TeamSide | null = null;
  /** Fielding rng captured once in onCreate so rebuilds reuse the same validated source. */
  private fieldingRng!: () => number;
  /** Per-side positioning state (layouts, bench, subs); null until the draft completes. */
  private positioning: Record<TeamSide, ReturnType<typeof createPositioningModule>> | null = null;
  /** Cross-play stamina ledger (spec §4 BENCH_STAMINA_REGEN; M8 closes the static-stamina gap). */
  private staminaById = new Map<string, number>();
  private fieldSlots: number = FIELD.FIELDING_POSITIONS.length;
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
  /** Mid-game reconnect grace window (seconds); test-only override, see MatchRoomOptions. */
  private reconnectGraceS: number = CONST.GAME.RECONNECT_GRACE_S;
  /**
   * Set immediately BEFORE the first `disconnect()` call (either onLeave branch
   * below). `disconnect()` forcibly closes every remaining client, which
   * RE-INVOKES this room's own `onLeave` for the survivor (Colyseus
   * `_forciblyCloseClient` triggers the same onLeave path with a consented-style
   * close). At that point `sideOf` still resolves (seats aren't cleared) and the
   * phase still isn't LOBBY, so without this guard the consented branch would
   * run a SECOND time for the survivor: a spurious `opponentLeft` naming the
   * WRONG side (the survivor's own) plus a second `disconnect()` call. Guarding
   * re-entry here is the fix, verified against `Room.js`'s `_forciblyCloseClient`.
   */
  private shuttingDown = false;

  /** Which seat a message came from; null = not seated (defensive — reject). */
  private sideOf(client: Client): TeamSide | null {
    if (client.sessionId === this.state.sessionA) return 'A';
    if (client.sessionId === this.state.sessionB) return 'B';
    return null;
  }

  private fieldingSide(): TeamSide {
    return this.rules.view().battingSide === 'A' ? 'B' : 'A';
  }

  /**
   * Highest pitch stat among the given ON-FIELD ids wins; ties go to the earlier
   * pick (id order = pick order). Derives from the on-field set, never the whole
   * squad — a benched best-arm cannot bowl (M8).
   */
  private defaultPitcherFromIds(ids: string[], side: TeamSide): string {
    const byId = new Map(this.squads[side].map((c) => [c.id, c]));
    let best: Character | undefined;
    for (const id of ids) {
      const c = byId.get(id);
      if (c !== undefined && (best === undefined || c.stats.pitch > best.stats.pitch)) best = c;
    }
    return best?.id ?? '';
  }

  private fieldingDeps(): FieldingDeps {
    return {
      rng: this.fieldingRng,
      hasBounced: () => this.physics.hasBounced(),
      applyThrow: (params) => this.physics.applyPitch(params),
      holdBallAt: (pos) => this.physics.spawnBall(pos),
      pressure: () => this.rules.pressure(this.runnersOnPosts()),
    };
  }

  /**
   * (Re)build the fielding side from its PositioningModule layout (M8): the
   * nominated pitcher pinned to the PITCHING_SPOT, everyone else on their
   * (possibly custom) layout position. Called when the draft completes, at every
   * play end (covers the fielding side changing on an innings switch / tiebreak
   * — the pitcher resets to that side's on-field default), on rematch, on
   * setPitcher and on reposition/substitute. Never during PLAY (callers
   * guarantee it). No-op until the draft completes (positioning is null).
   * The default layout equals the old M7 slot map (PositioningModule seeds
   * FIELDING_POSITIONS in pick order), so M7 expectations hold unchanged.
   */
  private rebuildFielding(): void {
    const side = this.fieldingSide();
    const squad = this.squads[side];
    const layout = this.positioning?.[side].view();
    if (layout === undefined || squad.length === 0) return; // draft not complete yet
    if (this.builtFieldingSide !== side || !layout.onField.includes(this.pitcherId)) {
      // Side changed (or the nominee is no longer on the field — defensive; the
      // substitute handler re-derives eagerly): the on-field best arm bowls.
      this.pitcherId = this.defaultPitcherFromIds(layout.onField, side);
      this.builtFieldingSide = side;
    }
    const byId = new Map(squad.map((c) => [c.id, c]));
    const setup: FielderSetup[] = layout.onField.map((id) => {
      const character = byId.get(id);
      const custom = layout.positions[id];
      if (character === undefined || custom === undefined) throw new Error(`positioning out of sync for ${id}`);
      const position = id === this.pitcherId ? FIELD.PITCHING_SPOT : custom;
      return { character, position, stamina: this.staminaById.get(id) ?? character.stats.stamina };
    });
    // Pitcher first (setup order = catch tie-break order, M7 convention);
    // Array.prototype.sort is stable, so the non-pitcher pick order is preserved.
    setup.sort((a, b) => (a.character.id === this.pitcherId ? -1 : b.character.id === this.pitcherId ? 1 : 0));
    this.fielding = createFieldingModule(setup, this.fieldingDeps());
    this.state.fielders.clear();
    this.state.currentPitcherId = this.pitcherId;
    this.syncFielders();
  }

  /** Mirror the DraftModule view into the schema (turn, pool, squads in pick order). */
  private syncDraft(): void {
    const v = this.draft.view();
    this.state.draftTurn = v.turn ?? '';
    this.state.draftRemaining.splice(0, this.state.draftRemaining.length, ...v.remainingIds);
    this.state.squadAIds.splice(0, this.state.squadAIds.length, ...v.pickedA);
    this.state.squadBIds.splice(0, this.state.squadBIds.length, ...v.pickedB);
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
    this.reconnectGraceS =
      isFiniteNumber(options.reconnectGraceS) && options.reconnectGraceS > 0
        ? options.reconnectGraceS
        : GAME.RECONNECT_GRACE_S;
    // Test-only field-slot override, runtime-validated like `seed` (wire-reachable).
    const slotsOpt = options.fieldSlotsOverride;
    this.fieldSlots =
      typeof slotsOpt === 'number' && Number.isInteger(slotsOpt) && slotsOpt > 0 && slotsOpt <= FIELD.FIELDING_POSITIONS.length
        ? slotsOpt
        : FIELD.FIELDING_POSITIONS.length;
    this.physics = await createPhysicsModule();

    // Placeholder mirror-roster squads so the rules view is coherent pre-draft;
    // rules.completeDraft(squads) replaces them the moment the real draft closes.
    const squadA = [...CHARACTERS];
    const squadB = [...CHARACTERS];
    this.rules = createRulesModule({ squadA, squadB });

    // Join options are wire data — validate before use (a non-function rng would
    // throw in the sim interval; a non-finite seed would poison createRng).
    const seed = isFiniteNumber(options.seed) ? options.seed : Date.now();
    this.fieldingRng = typeof options.rng === 'function' ? options.rng : createRng(seed);
    this.fielding = createFieldingModule([], this.fieldingDeps()); // placeholder until the draft completes
    this.draft = createDraftModule([...CHARACTERS], picksEach(CHARACTERS.length));
    this.running = createRunningModule();

    this.syncRulesView();
    this.syncDraft();
    this.syncFielders();
    this.syncRunners();

    this.onMessage('pitch', (client, message) => this.handlePitch(client, message));
    this.onMessage('draftPick', (client, message) => this.handleDraftPick(client, message));
    this.onMessage('setPitcher', (client, message) => this.handleSetPitcher(client, message));
    this.onMessage('swing', (client, message) => this.handleSwing(client, message));
    this.onMessage('runDecision', (client, message) => this.handleRunDecision(client, message));
    this.onMessage('reposition', (client, message) => this.handleReposition(client, message));
    this.onMessage('substitute', (client, message) => this.handleSubstitute(client, message));
    this.onMessage('setBatter', (client, message) => this.handleSetBatter(client, message));
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
      // Both seats filled: leave LOBBY and rest in DRAFT until the alternating
      // draft completes (handleDraftPick closes it via rules.completeDraft).
      this.rules.bothConnected();
    }
    this.syncRulesView();
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    // Re-entrancy guard: disconnect() (either branch below) forcibly closes
    // every remaining client, which re-invokes onLeave for the SURVIVOR before
    // this handler's own disconnect() promise settles. Without this guard the
    // survivor's re-entrant call would re-run the consented branch (seats/phase
    // still look mid-game) and broadcast a second, wrongly-sided opponentLeft.
    if (this.shuttingDown) return;
    console.log(`client ${client.sessionId} left`);
    const side = this.sideOf(client);
    if (side === null) return;
    if (this.phase() === 'LOBBY') {
      // Game not started: free the seat entirely (a different client may take it).
      if (side === 'A') this.state.sessionA = '';
      else this.state.sessionB = '';
      this.setConnected(side, false);
      return;
    }
    this.setConnected(side, false);
    if (consented === true) {
      // Deliberate quit mid-game: no grace — tell the survivor and shut down.
      // this.disconnect() is DELIBERATELY NOT awaited: Colyseus only finishes
      // disposing once every concurrent onLeave call (including this one)
      // returns (#_onLeaveConcurrent must reach 0 — see Room._disposeIfEmpty).
      // Awaiting disconnect() from inside onLeave is a real deadlock: this
      // handler would never return, so the counter never reaches 0, so
      // disconnect()'s own promise (which waits on the "disconnect" event)
      // never resolves either. Fire-and-forget, with the rejection logged.
      this.broadcast('opponentLeft', { side });
      this.shuttingDown = true; // set BEFORE disconnect() — see field comment
      this.disconnect().catch((err: unknown) => console.error('[MatchRoom] disconnect() after consented quit failed:', err));
      return;
    }
    // Unexpected drop: freeze the game and hold the seat for the grace window.
    this.state.paused = true;
    try {
      await this.allowReconnection(client, this.reconnectGraceS);
      this.setConnected(side, true);
      if (this.state.connectedA && this.state.connectedB) this.state.paused = false;
    } catch {
      // Grace expired (allowReconnection rejected) OR the room is already
      // disposing because the OTHER seat's onLeave already ran the consented
      // or grace-expiry branch (both players gone). `this.clients.length > 0`
      // distinguishes the two: >0 means a survivor is still connected and
      // needs telling; ===0 means nobody is left to notify (both players
      // already left — broadcasting/disconnecting again would be pointless,
      // and the room is disposing anyway). The shuttingDown guard above
      // covers the interleaving where THIS call is the survivor's re-entrant
      // onLeave triggered by the other branch's disconnect().
      if (this.clients.length > 0) {
        this.broadcast('opponentLeft', { side });
        this.shuttingDown = true; // set BEFORE disconnect() — see field comment
        this.disconnect().catch((err: unknown) => console.error('[MatchRoom] disconnect() after reconnect-grace expiry failed:', err));
      }
    }
  }

  private setConnected(side: TeamSide, value: boolean): void {
    if (side === 'A') this.state.connectedA = value;
    else this.state.connectedB = value;
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

  /**
   * Record and send a structured rejection { message, phase, reason } to the
   * OFFENDING client only. `state.lastRejection` still mirrors the payload for
   * tests (and any future spectators), but the actual `rejected` message must
   * not broadcast: a routine wrongRole/paused rejection for client A is not
   * relevant to client B and must never appear on B's status line.
   */
  private reject(client: Client, message: string, reason: string): void {
    const payload = { message, phase: this.phase(), reason };
    this.state.lastRejection = JSON.stringify(payload);
    client.send('rejected', payload);
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

  private handleDraftPick(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'draftPick', 'paused');
      return;
    }
    if (this.phase() !== 'DRAFT') {
      this.reject(client, 'draftPick', `only allowed in DRAFT (phase ${this.phase()})`);
      return;
    }
    const side = this.sideOf(client);
    if (side === null || side !== this.draft.view().turn) {
      this.reject(client, 'draftPick', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<DraftPickInput>;
    if (typeof m.id !== 'string' || !this.draft.pick(side, m.id)) {
      this.reject(client, 'draftPick', 'unknown or already-picked character');
      return;
    }
    this.syncDraft();
    if (this.draft.view().complete) {
      const squads = this.draft.squads();
      this.squads = { A: squads.squadA, B: squads.squadB };
      // M8: per-side positioning state (layouts, bench, subs) and the cross-play
      // stamina ledger, seeded at stat for every drafted character.
      this.positioning = {
        A: createPositioningModule(squads.squadA, this.fieldSlots),
        B: createPositioningModule(squads.squadB, this.fieldSlots),
      };
      this.staminaById.clear();
      for (const c of [...squads.squadA, ...squads.squadB]) this.staminaById.set(c.id, c.stats.stamina);
      this.rules.completeDraft(squads); // DRAFT → INITIAL_POSITIONING, real batting orders in
      this.rebuildFielding(); // innings 1: side B fields with its default pitcher
      this.syncRulesView();
      this.syncPositioning();
    }
  }

  private handleSetPitcher(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'setPitcher', 'paused');
      return;
    }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'setPitcher', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject(client, 'setPitcher', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<SetPitcherInput>;
    const squad = this.squads[this.fieldingSide()];
    if (typeof m.id !== 'string' || !squad.some((c) => c.id === m.id)) {
      this.reject(client, 'setPitcher', 'not in your squad');
      return;
    }
    // M8: a benched character cannot bowl — the nominee must be on the field
    // (rebuildFielding pins the pitcher from the layout's on-field set).
    const layout = this.positioning?.[this.fieldingSide()].view();
    if (layout !== undefined && !layout.onField.includes(m.id)) {
      this.reject(client, 'setPitcher', 'benched — substitute them on before nominating');
      return;
    }
    this.pitcherId = m.id;
    this.rebuildFielding();
  }

  // ---- M8 positioning handlers -----------------------------------------------

  private handleReposition(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'reposition', 'paused');
      return;
    }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'reposition', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject(client, 'reposition', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<RepositionInput>;
    if (typeof m.id !== 'string' || !isFiniteNumber(m.x) || !isFiniteNumber(m.z)) {
      this.reject(client, 'reposition', 'malformed input');
      return;
    }
    if (m.id === this.pitcherId) {
      this.reject(client, 'reposition', 'the pitcher moves via setPitcher');
      return;
    }
    const pos = this.positioning?.[this.fieldingSide()];
    if (pos === undefined || !pos.reposition(m.id, m.x, m.z)) {
      this.reject(client, 'reposition', 'illegal spot or not an on-field fielder');
      return;
    }
    this.rebuildFielding();
    this.syncPositioning();
  }

  private handleSubstitute(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'substitute', 'paused');
      return;
    }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'substitute', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject(client, 'substitute', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<SubstituteInput>;
    if (typeof m.outId !== 'string' || typeof m.inId !== 'string') {
      this.reject(client, 'substitute', 'malformed input');
      return;
    }
    const side = this.fieldingSide();
    const pos = this.positioning?.[side];
    if (pos === undefined || !pos.substitute(m.outId, m.inId)) {
      this.reject(client, 'substitute', 'not a legal substitution (bench membership or cap)');
      return;
    }
    if (m.outId === this.pitcherId) {
      // The bowler left the field: the new on-field set's best arm takes over.
      this.pitcherId = this.defaultPitcherFromIds(pos.view().onField, side);
    }
    this.rebuildFielding();
    this.syncPositioning();
  }

  private handleSetBatter(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'setBatter', 'paused');
      return;
    }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'setBatter', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.rules.view().battingSide) {
      this.reject(client, 'setBatter', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<SetBatterInput>;
    if (typeof m.id !== 'string' || !this.rules.setNextBatter(m.id)) {
      // In TIEBREAK the queue is empty by design (fixed sudden-death rotation),
      // so setNextBatter always returns false and this prose reason fires.
      this.reject(
        client,
        'setBatter',
        this.rules.view().tiebreak
          ? 'not in the batting queue (the tiebreak rotation is fixed)'
          : 'not in the batting queue',
      );
      return;
    }
    this.syncRulesView();
  }

  private handlePitch(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'pitch', 'paused');
      return;
    }
    if (this.phase() !== 'PLAY') {
      this.reject(client, 'pitch', `pitch only allowed in PLAY (phase ${this.phase()})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject(client, 'pitch', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<PitchInput>;
    if (this.state.ballLive || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.reject(client, 'pitch', 'ball already live or malformed input');
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
    if (this.state.paused) {
      this.reject(client, 'swing', 'paused');
      return;
    }
    if (this.phase() !== 'PLAY') {
      this.reject(client, 'swing', `swing only allowed in PLAY (phase ${this.phase()})`);
      return;
    }
    if (this.sideOf(client) !== this.rules.view().battingSide) {
      this.reject(client, 'swing', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<SwingMessage>;
    // The client 'timing' field is accepted but ignored; the server's own
    // sim-time is authoritative (M3 decision, latency comp revisited in M6).
    if (!this.state.ballLive || this.swung || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.reject(client, 'swing', 'no live pitch, already swung, or malformed input');
      return;
    }
    const error = this.timingErrorNow();
    if (error === null) {
      this.reject(client, 'swing', 'ball never reaches the batter');
      return;
    }
    this.swung = true;
    const batterId = this.rules.view().currentBatterId;
    if (batterId === null) {
      this.reject(client, 'swing', 'no batter up');
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
    if (this.state.paused) {
      this.reject(client, 'runDecision', 'paused');
      return;
    }
    if (this.phase() !== 'PLAY') {
      this.reject(client, 'runDecision', `runDecision only allowed in PLAY (phase ${this.phase()})`);
      return;
    }
    if (this.sideOf(client) !== this.rules.view().battingSide) {
      this.reject(client, 'runDecision', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<RunDecisionInput>;
    const hasLiveRunner = this.contactMade && this.running.runners().some((r) => !r.out && !r.home);
    if (!this.state.ballLive || !hasLiveRunner || typeof m.go !== 'boolean') {
      this.reject(client, 'runDecision', 'no live runner or malformed input');
      return;
    }
    // Shared stop/go applies to every live runner (RunningModule; user decision 2).
    this.running.setDecision(m.go);
  }

  private handleConfirmPositioning(client: Client): void {
    if (this.state.paused) {
      this.reject(client, 'confirmPositioning', 'paused');
      return;
    }
    const side = this.sideOf(client);
    if (side === null) {
      this.reject(client, 'confirmPositioning', 'wrongRole');
      return;
    }
    if (this.phase() !== 'INITIAL_POSITIONING') {
      this.reject(client, 'confirmPositioning', `only allowed in INITIAL_POSITIONING (phase ${this.phase()})`);
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
    if (this.state.paused) {
      this.reject(client, 'readyForPlay', 'paused');
      return;
    }
    const side = this.sideOf(client);
    if (side === null) {
      this.reject(client, 'readyForPlay', 'wrongRole');
      return;
    }
    if (this.phase() !== 'PRE_PLAY') {
      this.reject(client, 'readyForPlay', `only allowed in PRE_PLAY (phase ${this.phase()})`);
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
    if (this.state.paused) {
      this.reject(client, 'rematch', 'paused');
      return;
    }
    if (this.sideOf(client) === null) {
      this.reject(client, 'rematch', 'wrongRole');
      return;
    }
    if (!this.rules.rematch()) {
      this.reject(client, 'rematch', `only allowed in GAME_OVER (phase ${this.phase()})`);
      return;
    }
    // Fresh match: clear runners (innings/rematch is the only running.reset seam),
    // the innings-1 fielding side rebuilt with its default pitcher (the null
    // builtFieldingSide forces the pitcher re-derivation), ball parked, all
    // latches cleared. The draft is NOT re-run — squads persist across a rematch,
    // but positioning state and the stamina ledger start fresh (spec defaults).
    this.running.reset();
    if (this.squads.A.length > 0 && this.squads.B.length > 0) {
      this.positioning = {
        A: createPositioningModule(this.squads.A, this.fieldSlots),
        B: createPositioningModule(this.squads.B, this.fieldSlots),
      };
      this.staminaById.clear();
      for (const c of [...this.squads.A, ...this.squads.B]) this.staminaById.set(c.id, c.stats.stamina);
    }
    this.builtFieldingSide = null;
    this.rebuildFielding();
    this.syncPositioning();
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
    if (this.state.paused) return; // frozen: no sim time accrues, so play timeout/rest timers hold
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
    // M8 stamina ledger: absorb the played module's drained values FIRST (the
    // fielding state is still the module that just played), then everyone NOT on
    // the fielding field regains bench stamina, capped at stat (spec §4).
    for (const f of this.fielding.getFielders()) this.staminaById.set(f.id, f.stamina);
    const onField = new Set(this.fielding.getFielders().map((f) => f.id));
    for (const [id, s] of this.staminaById) {
      if (onField.has(id)) continue;
      const stat = getCharacter(id).stats.stamina;
      this.staminaById.set(id, Math.min(stat, s + GAME.BENCH_STAMINA_REGEN));
    }

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
      // neither of which should reach here. Log, clear runners, rebuild fielding
      // (the stamina ledger absorb above already ran; without a rebuild the stale
      // module would regress the ledger by one play on the next absorb), and recover.
      console.error('[MatchRoom] resolvePlay returned null unexpectedly');
      this.running.reset();
      this.rebuildFielding();
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
    if (v.inningsIndex !== prevInnings) {
      // Substitution caps are per innings (spec §4); layouts and bench persist.
      this.positioning?.A.resetSubs();
      this.positioning?.B.resetSubs();
      this.syncPositioning();
    }
    this.syncRulesView();
    this.syncRunners();
    this.syncFielders();
    // M7: the play may have switched the fielding side (innings switch / tiebreak
    // flip); rebuild the on-field five from the new side's squad, resetting the
    // pitcher to that side's default. Same-side rebuilds are equivalent to the
    // fielding.reset() above (fresh module, same setup, same nominated pitcher).
    this.rebuildFielding();
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
    // M8: the batting side's remaining queue (changes at every play resolution too).
    this.state.queueIds.splice(0, this.state.queueIds.length, ...v.queue);
  }

  /** Mirror both PositioningModule views into the schema (bench membership + subs used). */
  private syncPositioning(): void {
    if (this.positioning === null) return;
    const a = this.positioning.A.view();
    const b = this.positioning.B.view();
    this.state.benchA.splice(0, this.state.benchA.length, ...a.bench);
    this.state.benchB.splice(0, this.state.benchB.length, ...b.bench);
    this.state.subsUsedA = a.subsUsed;
    this.state.subsUsedB = b.subsUsed;
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
