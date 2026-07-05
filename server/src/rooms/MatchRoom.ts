import { Room, type Client, type RoomException } from '@colyseus/core';
import {
  CHARACTERS,
  CONST,
  createRng,
  getCharacter,
  hitAbilityMods,
  NEUTRAL_PITCH_MODS,
  pitchAbilityMods,
  spinReadPenalty,
  timingWindow,
  type Character,
  type DraftPickInput,
  type FielderSetup,
  type MatchPhase,
  type PitchAbilityMods,
  type PlayOutcome,
  type RepositionInput,
  type RollEvent,
  type SetBatterInput,
  type SetPitcherInput,
  type SubstituteInput,
  type SwingInput,
  type TeamSide,
} from '@carlquest/shared';
import { createAutoPlayModule } from '../modules/AutoPlayModule';
import { createPositioningModule } from '../modules/PositioningModule';
import { createPhysicsModule, type PhysicsModule } from '../modules/PhysicsModule';
import { resolvePitch } from '../modules/PitchModule';
import { resolveSwing } from '../modules/HitModule';
import { createFieldingModule, type FieldingDeps, type FieldingEvent, type FieldingModule } from '../modules/FieldingModule';
import { createRunningModule, type RunnerView } from '../modules/RunningModule';
import { createRulesModule } from '../modules/RulesModule';
import { createDraftModule, picksEach } from '../modules/DraftModule';
import { FielderSchema, MatchState, RunnerSchema } from './MatchState';

const { PHYSICS, GAME, FIELD, ABILITY } = CONST;

/**
 * The one roster character whose WALL ability the room wires directly (spec §3):
 * their fielding position doubles as a physical blocker capsule while the ball
 * is live post-contact. Derived from the roster, not a hard-coded id.
 */
const WALL_FIELDER_ID = CHARACTERS.find((c) => c.ability === 'WALL')?.id ?? '';

/** The pre-sampled auto-swing awaiting the ball's batting-plane crossing. */
interface PendingSwing {
  input: SwingInput;
  timingError: number;
  roll: RollEvent;
}

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
  /** Latched when the live pitch first crosses the batting-square plane (the auto-swing moment). */
  private crossed = false;
  /**
   * Auto-play decision maker (2026-07-05 redesign). DELIBERATELY shares the
   * validated fielding rng stream — one seed drives the whole match's dice, and
   * the draw order is code order (pitch 3 draws + swing 2 at the pitch beat,
   * then catch/fumble and run draws as they arise in tick order), so a seeded
   * room replays deterministically.
   */
  private autoPlay!: ReturnType<typeof createAutoPlayModule>;
  /** Sim-time at which the next auto pitch beat fires; null = none scheduled. */
  private pitchBeatAt: number | null = null;
  /**
   * Sim-time at which a missed swing's ball respawns for the re-pitch
   * (2026-07-05 readable-game overhaul): set when the pre-sampled swing
   * resolves as a miss, so the re-pitch loop no longer waits ~7 s for the
   * dead flight to roll to rest. Rest/timeout stays as the fallback for
   * flights that never cross the plane. Null = none pending.
   */
  private missRespawnAt: number | null = null;
  /**
   * Outcome hold (2026-07-05 readable-game overhaul): pending finalisation of
   * a resolved play. resolvePlayNow() broadcasts the resolution and freezes
   * the world; finalisePlay() (ball respawn, fielding reset/rebuild, syncs)
   * runs OUTCOME_HOLD_S sim-seconds later from tick — clients get a readable
   * tableau of how the play died instead of an instant whole-field teleport.
   * Sim-time based, so pause freezes the hold; handleRematch and onDispose
   * clear it (their own resets supersede the finalisation).
   */
  private pendingFinalise: { at: number; inningsChanged: boolean; contextChanged: boolean } | null =
    null;
  /** Swing decision pre-sampled at the pitch beat, applied at the plane crossing. */
  private pendingSwing: PendingSwing | null = null;
  /** Sim-time of the last broadcast run RollEvent (AUTOPLAY_BEAT_MIN_GAP_S rate limit). */
  private lastRunRollAt = -Infinity;
  /** Last observed atPost per live runner — post-ARRIVAL transitions trigger run beats. */
  private lastAtPost = new Map<string, number | null>();
  /** True from bat contact until the play ends — gates fielding/running/outcome resolution. */
  private contactMade = false;
  /**
   * The delivering pitcher's ability mods, captured at each handlePitch (M9).
   * Neutral until the first pitch; a swing can only follow a pitch (ballLive
   * gate), so resolveSwing always sees the mods of the pitch it faces.
   * (Reassigned wholesale, never mutated — the shared neutral is frozen.)
   */
  private currentPitcherMods: PitchAbilityMods = NEUTRAL_PITCH_MODS;
  /** The delivered pitch's clamped spin input (spin-read penalty fact), captured at handlePitch (M9). */
  private lastPitchSpinInput = 0;
  /**
   * The delivering pitcher's spin stat, captured at handlePitch alongside the
   * mods above (final-review minor): the swing must read the facts of the
   * pitch it faces, not whoever is nominated pitcher at swing time.
   */
  private pitcherSpinStat = 0;
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
      // Every catch/fumble dice moment goes straight out as a roll broadcast.
      onRoll: (e) => this.broadcast('roll', e),
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
    // ONE auto-play module on the SAME validated rng stream as fielding (see
    // the field comment: shared stream, draw order = code order, deterministic
    // replays from a single seed).
    this.autoPlay = createAutoPlayModule(this.fieldingRng);
    this.fielding = createFieldingModule([], this.fieldingDeps()); // placeholder until the draft completes
    this.draft = createDraftModule([...CHARACTERS], picksEach(CHARACTERS.length));
    this.running = createRunningModule();

    this.syncRulesView();
    this.syncDraft();
    this.syncFielders();
    this.syncRunners();

    this.onMessage('pitch', (client) => this.handlePitch(client));
    this.onMessage('draftPick', (client, message) => this.handleDraftPick(client, message));
    this.onMessage('setPitcher', (client, message) => this.handleSetPitcher(client, message));
    this.onMessage('swing', (client) => this.handleSwing(client));
    this.onMessage('runDecision', (client) => this.handleRunDecision(client));
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
    // A pending outcome-hold finalisation dies with the room (the simulation
    // interval is torn down with disposal; this is belt-and-braces so nothing
    // can ever fire it against disposed physics).
    this.pendingFinalise = null;
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

  // ---- Tombstoned player play-messages (2026-07-05 auto-play redesign) --------
  // Plays resolve automatically as dice-roll beats; the handlers stay registered
  // so a stale client gets a structured rejection instead of a silent drop.
  // Paused-first ordering is kept; every other check is subsumed by the
  // unconditional prose reason.

  private handlePitch(client: Client): void {
    if (this.state.paused) {
      this.reject(client, 'pitch', 'paused');
      return;
    }
    this.reject(client, 'pitch', 'plays resolve automatically');
  }

  private handleSwing(client: Client): void {
    if (this.state.paused) {
      this.reject(client, 'swing', 'paused');
      return;
    }
    this.reject(client, 'swing', 'plays resolve automatically');
  }

  private handleRunDecision(client: Client): void {
    if (this.state.paused) {
      this.reject(client, 'runDecision', 'paused');
      return;
    }
    this.reject(client, 'runDecision', 'plays resolve automatically');
  }

  // ---- Auto-play beats (2026-07-05 redesign) -----------------------------------

  /**
   * The pitch beat: the AutoPlayModule picks the delivery, the EXISTING
   * resolvePitch path applies it (mods, spin-fact capture — byte-for-byte the
   * old handlePitch flow), the pitch RollEvent goes out, and the batter's swing
   * decision is sampled IMMEDIATELY (fixed draw order on the shared rng stream)
   * to be applied when the ball crosses the batting plane.
   */
  private autoPitch(): void {
    this.pitchBeatAt = null;
    this.missRespawnAt = null; // defensive: a fresh flight owns its own miss timer
    const pitcher = getCharacter(this.state.currentPitcherId);
    // M9: the pitcher's ability mods shape the pitch (CANNON_ARM speed,
    // CURVEBALL_MASTER spin/onset) and are held for the coming swing's context
    // (CANNON_ARM window shrink, spin-read facts). The auto decision's spin
    // input is already clamped to the [-1, 1] the pitch flies with.
    const mods = pitchAbilityMods(pitcher);
    const decision = this.autoPlay.pitchDecision(pitcher, mods);
    const params = resolvePitch(pitcher.stats, decision.input, mods);
    this.currentPitcherMods = mods;
    this.lastPitchSpinInput = Math.max(-1, Math.min(1, decision.input.spinInput));
    this.pitcherSpinStat = pitcher.stats.spin;
    this.physics.applyPitch(params);
    this.state.ballLive = true;
    this.contactMade = false;
    this.crossed = false;
    this.liveSince = this.simTime;
    this.restSince = null;
    this.broadcast('roll', decision.roll);

    // Pre-sample the swing NOW. The effective window is EXACTLY resolveSwing's
    // chain (shared formulas): timingWindow(reflex) × the pitcher's CANNON_ARM
    // window mult × the spin-read penalty (skipped for a SWITCH-immune batter).
    const batterId = this.rules.view().currentBatterId;
    if (batterId === null) {
      this.pendingSwing = null; // defensive: no batter up (unreachable in PLAY)
      return;
    }
    const batter = getCharacter(batterId);
    const spinFactor = hitAbilityMods(batter).spinReadImmune
      ? 1
      : spinReadPenalty(this.pitcherSpinStat, this.lastPitchSpinInput);
    const effectiveWindow = timingWindow(batter.stats.reflex, mods.batterTimingWindowMult * spinFactor);
    this.pendingSwing = this.autoPlay.swingDecision(batter, effectiveWindow);
  }

  /**
   * Apply the pre-sampled swing at the batting-plane crossing through the
   * EXISTING resolveSwing path (full SwingContext, exactly as the old
   * handleSwing built it). The broadcast swing RollEvent's success is
   * RECOMPUTED from resolveSwing's actual contact result so the presentation
   * can never contradict reality. A miss falls into the existing no-contact
   * flow (ball flies on; the rest/timeout respawn re-schedules the pitch beat).
   */
  private applyAutoSwing(): void {
    const pending = this.pendingSwing;
    this.pendingSwing = null;
    if (pending === null) return;
    const batterId = this.rules.view().currentBatterId;
    if (batterId === null) return;
    const batter = getCharacter(batterId);
    const pressure = this.rules.pressure(this.runnersOnPosts());
    const result = resolveSwing(batter.stats, pending.input, pending.timingError, {
      mods: hitAbilityMods(batter),
      isFinalInnings: this.rules.isFinalInnings(),
      timingWindowMult: this.currentPitcherMods.batterTimingWindowMult,
      pitcherSpinStat: this.pitcherSpinStat,
      pitchSpinInput: this.lastPitchSpinInput,
      pressure,
    });
    this.broadcast('roll', { ...pending.roll, success: result.contact });
    if (!result.contact) {
      // Missed swing (2026-07-05): don't watch the dead flight roll to rest —
      // schedule the fast respawn. The tick's no-contact branch fires it.
      this.missRespawnAt = this.simTime + GAME.MISS_RESPAWN_S;
      return;
    }
    this.physics.applyHit(result.params);
    // Catch arming (2026-07-05): the hit is applied at the ball's current
    // position, which IS the launch point — arm the flight so no fielder can
    // catch it until it has travelled CATCH_ARM_DISTANCE_M (kills the
    // backstop contact-tick instant catch; see FieldingModule.armFlight).
    this.fielding.armFlight(this.physics.getBallState().position);
    this.running.startRun(batter);
    this.contactMade = true;
    // applyHit cleared the crossing latches; seed lastExposedPosts with the new
    // runner's opening exposure (post 1) so the first checkRunOut does not treat
    // it as an exposure CHANGE and discard a legitimate first-tick crossing.
    this.lastExposedPosts = new Set(this.running.exposures().map((e) => e.post));
    // Seed the arrival tracker (parked survivors must not read as fresh
    // arrivals) and take the initial run decision at contact.
    this.lastAtPost.clear();
    for (const r of this.running.runners()) this.lastAtPost.set(r.id, r.atPost);
    this.autoRunBeat();
  }

  /**
   * One auto run beat: read the live situation (ball held? how far is the ball
   * from the threatened post?), roll the go/stay decision for the lead runner,
   * apply it via the EXISTING shared stop/go, and broadcast the run RollEvent —
   * rate-limited to one broadcast per AUTOPLAY_BEAT_MIN_GAP_S sim seconds (the
   * decision is still applied when the broadcast is suppressed). Fired at
   * contact and at every runner post arrival.
   */
  private autoRunBeat(): void {
    const decisionRunner = this.leadRunner();
    if (decisionRunner === null) return;
    const targetPost = decisionRunner.targetPost ?? (decisionRunner.atPost !== null ? decisionRunner.atPost + 1 : 1);
    const post = FIELD.POSTS[targetPost - 1];
    if (post === undefined) return; // lead runner already home — nothing to decide
    const ball = this.physics.getBallState();
    const situation = {
      ballHeld: this.fielding.holderId() !== null,
      ballDistToTargetPost: Math.hypot(ball.position.x - post.x, ball.position.z - post.z),
    };
    const decision = this.autoPlay.runDecision(getCharacter(decisionRunner.id), situation);
    this.running.setDecision(decision.go);
    if (this.simTime - this.lastRunRollAt >= GAME.AUTOPLAY_BEAT_MIN_GAP_S) {
      this.broadcast('roll', decision.roll);
      this.lastRunRollAt = this.simTime;
    }
  }

  /** The most advanced live runner (exposed target beats a parked post; ties to the further post). */
  private leadRunner(): RunnerView | null {
    let best: RunnerView | null = null;
    let bestProgress = -1;
    for (const r of this.running.runners()) {
      if (r.out || r.home) continue;
      const progress = r.targetPost ?? r.atPost ?? 0;
      if (progress > bestProgress) {
        best = r;
        bestProgress = progress;
      }
    }
    return best;
  }

  /**
   * Post-ARRIVAL detection for run beats: true when any live runner's atPost
   * gained a value it did not have last tick (halt or park at a post). The
   * tracker is seeded at contact so parked survivors never read as arrivals.
   */
  private detectArrivals(): boolean {
    let arrived = false;
    const seen = new Set<string>();
    for (const r of this.running.runners()) {
      seen.add(r.id);
      const prev = this.lastAtPost.get(r.id) ?? null;
      if (!r.out && !r.home && r.atPost !== null && r.atPost !== prev) arrived = true;
      this.lastAtPost.set(r.id, r.atPost);
    }
    for (const key of [...this.lastAtPost.keys()]) {
      if (!seen.has(key)) this.lastAtPost.delete(key);
    }
    return arrived;
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
      // PLAY entered: schedule the auto pitch beat on SIM time (pause-safe —
      // simTime freezes while paused, so the beat freezes with it). Both sides
      // CAN ready during the previous play's outcome hold (the phase mirror
      // syncs at resolve time), and that is safe for ANY values of the
      // constants — not a PITCH_DELAY_S == OUTCOME_HOLD_S coincidence: the
      // tick's finalise gate sits BEFORE the beat check and returns until
      // finalisePlay has run, so however early this beat is scheduled it
      // cannot fire before the field is respawned and rebuilt.
      if (this.phase() === 'PLAY') {
        this.pitchBeatAt = this.simTime + GAME.AUTOPLAY_PITCH_DELAY_S;
      }
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
    this.physics.clearBlocker(WALL_FIELDER_ID); // WALL is per live post-contact ball (M9)
    this.physics.spawnBall();
    this.syncBall(); // fresh match: schema ball parked, not the old flight's last state
    this.state.ballLive = false;
    this.contactMade = false;
    this.restSince = null;
    this.lastExposedPosts = new Set();
    this.pitchBeatAt = null;
    this.pendingSwing = null;
    this.missRespawnAt = null;
    // Rematch during the GAME_OVER outcome hold: this handler's own full reset
    // supersedes the pending finalisation — clear it so finalisePlay never
    // fires over the fresh match state (2026-07-05 outcome hold).
    this.pendingFinalise = null;
    this.lastAtPost.clear();
    this.lastRunRollAt = -Infinity;
    this.state.lastOutcome = '';
    this.confirmed = { A: false, B: false };
    this.ready = { A: false, B: false };
    this.syncRulesView();
    this.syncRunners();
    this.syncFielders();
  }

  // ---- Simulation tick -------------------------------------------------------

  private tick(deltaMs: number): void {
    if (this.state.paused) return; // frozen: no sim time accrues, so play timeout/rest timers hold
    // Clamp to avoid a spiral-of-death catch-up burst after an event-loop stall.
    const dt = Math.min(deltaMs / 1000, PHYSICS.SIM_MAX_CATCHUP);
    this.simTime += dt;
    // Outcome hold (2026-07-05): between resolvePlayNow and finalisePlay the
    // world is a frozen tableau — no physics step, no beats, no syncs; the
    // schema keeps the exact positions the play died with. Sim-time based,
    // so a pause freezes the hold along with everything else.
    if (this.pendingFinalise !== null) {
      if (this.simTime >= this.pendingFinalise.at) this.finalisePlay();
      return;
    }
    // Auto pitch beat: fires only in PLAY with no live ball, when its sim-time
    // is due (pause freezes simTime, so beats freeze automatically).
    if (
      this.pitchBeatAt !== null &&
      this.simTime >= this.pitchBeatAt &&
      this.phase() === 'PLAY' &&
      !this.state.ballLive
    ) {
      this.autoPitch();
    }
    if (!this.state.ballLive) return;

    // WALL (M9): while the ball is live post-contact — the same window the
    // fielder AI runs — the blocker capsule shadows the whale's position.
    // Updated BEFORE the step so this tick's substeps collide with where he
    // currently stands; cleared whenever he is not on the fielding side's field.
    if (this.contactMade) this.updateWallBlocker();

    const beforePos = this.physics.getBallState().position;
    this.physics.step(dt);
    let state = this.physics.getBallState();

    // The ball's first batting-square plane crossing is the auto-swing moment:
    // the pre-sampled swing decision is applied here through resolveSwing.
    if (!this.crossed && beforePos.z > FIELD.BATTING_SQUARE.z && state.position.z <= FIELD.BATTING_SQUARE.z) {
      this.crossed = true;
      this.applyAutoSwing();
      // A connected hit replaced the flight mid-tick: refresh the snapshot so
      // fielding/rest tracking below see the hit ball, not the stale pitch.
      state = this.physics.getBallState();
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
        this.resolvePlayNow(resolved);
      } else {
        // Run beats: every post arrival re-rolls the shared go/stay decision.
        if (this.detectArrivals()) this.autoRunBeat();
        this.syncRunners();
        this.syncFielders();
      }
    } else if (
      (this.missRespawnAt !== null && this.simTime >= this.missRespawnAt) ||
      this.updateRestTracking(state)
    ) {
      // No contact this play (un-hit pitch or a missed swing): quietly respawn
      // and stay in PLAY — no play resolution — and RE-SCHEDULE the pitch beat
      // so the auto re-pitch loop never stalls. A resolved MISS fires the fast
      // MISS_RESPAWN_S timer (2026-07-05 — the old path watched the dead ball
      // roll to rest for ~7 s); rest/timeout remains the fallback for flights
      // that never cross the plane.
      this.state.ballLive = false;
      this.physics.spawnBall();
      this.syncBall(); // the schema must show the parked ball, not the dead flight's last state
      this.restSince = null;
      this.pendingSwing = null;
      this.missRespawnAt = null;
      this.pitchBeatAt = this.simTime + GAME.AUTOPLAY_PITCH_DELAY_S;
    }
  }

  /**
   * Upsert the WALL blocker capsule at the whale's current fielding position,
   * or remove it when the whale is not on the field this play (M9, spec §3).
   * Derives presence from the fielding module's live fielders — the whale can
   * only block while drafted AND fielding. The capsule's centre height puts
   * its lower cap on the ground. The whale still fields normally (chase/catch);
   * the blocker is additional.
   */
  private updateWallBlocker(): void {
    const whale = this.fielding.getFielders().find((f) => f.id === WALL_FIELDER_ID);
    if (whale === undefined) {
      this.physics.clearBlocker(WALL_FIELDER_ID);
      return;
    }
    this.physics.setBlocker(
      WALL_FIELDER_ID,
      { x: whale.x, y: ABILITY.WALL_BLOCKER_HALF_HEIGHT + ABILITY.WALL_BLOCKER_RADIUS, z: whale.z },
      ABILITY.WALL_BLOCKER_HALF_HEIGHT,
      ABILITY.WALL_BLOCKER_RADIUS,
    );
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
   * Resolve the play NOW (2026-07-05 outcome-hold split of the old endPlay):
   * mark the out runner (caught batter / run-out) so settlePlay removes them,
   * gather per-runner facts, let RulesModule resolve scoring/outs/rotation/
   * phase, then broadcast + mirror the resolution and schedule finalisePlay()
   * for OUTCOME_HOLD_S sim-seconds later. Everything PRESENTATIONAL (ball
   * respawn, fielding reset/rebuild, runner/fielder schema syncs) is deferred
   * to finalisePlay so clients see the tableau of how the play died. The
   * PHASE mirror syncs HERE, at resolve time (deliberate, per the plan): the
   * schema stays honest — rules.resolvePlay has already flipped the phase —
   * and the tableau is about POSITIONS, not phase; a GAME_OVER overlay
   * appearing over the frozen final play IS the tableau.
   */
  private resolvePlayNow(resolved: Resolved): void {
    // M8 stamina ledger: absorb the played module's drained values FIRST (the
    // fielding state is still the module that just played — it stays untouched
    // through the hold, no ticks run), then everyone NOT on the fielding field
    // regains bench stamina, capped at stat (spec §4).
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

    // The play is over: kill the live flags so no further beats/fielding run,
    // but leave the BALL and the runner/fielder SCHEMA exactly as they died —
    // finalisePlay repaints them after the hold.
    this.state.ballLive = false;
    this.contactMade = false;
    this.physics.clearBlocker(WALL_FIELDER_ID); // WALL is per live post-contact ball (M9)
    this.restSince = null;
    this.lastExposedPosts = new Set();
    this.confirmed = { A: false, B: false };
    this.ready = { A: false, B: false };
    // Auto-play beat state is per play; the next handleReadyForPlay re-arms it.
    this.pitchBeatAt = null;
    this.pendingSwing = null;
    this.missRespawnAt = null;
    this.lastAtPost.clear();
    this.lastRunRollAt = -Infinity;

    if (resolution === null) {
      // Defensive: resolvePlay only returns null out of PLAY / with no batter,
      // neither of which should reach here. Log, clear runners, rebuild fielding
      // (the stamina ledger absorb above already ran; without a rebuild the stale
      // module would regress the ledger by one play on the next absorb), and
      // recover SYNCHRONOUSLY — no outcome hold for a play that has no outcome.
      console.error('[MatchRoom] resolvePlay returned null unexpectedly');
      this.physics.spawnBall();
      this.syncBall();
      this.fielding.reset();
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
    // Resolve-time phase/score sync (see the method doc); position syncs wait.
    this.syncRulesView();
    this.pendingFinalise = {
      at: this.simTime + GAME.OUTCOME_HOLD_S,
      inningsChanged: v.inningsIndex !== prevInnings,
      contextChanged: v.phase === 'GAME_OVER' || v.inningsIndex !== prevInnings || v.tiebreak,
    };
  }

  /**
   * Finalise a resolved play OUTCOME_HOLD_S after resolvePlayNow (2026-07-05):
   * ball respawned + re-synced (syncBall only runs while the ball is live, so
   * without this the schema advertises the DEAD flight's final state all the
   * way through PRE_PLAY — the M3-era trap, still real), fielding reset,
   * runners cleared ONLY when the innings context changed (innings switch,
   * tiebreak, or game over — otherwise parked survivors persist into the next
   * play), per-innings sub caps reset, schema repainted, and the on-field five
   * rebuilt (M7: the play may have switched the fielding side; the pitcher
   * resets to the new side's default. Same-side rebuilds are equivalent to
   * the fielding.reset() — fresh module, same setup, same nominated pitcher).
   */
  private finalisePlay(): void {
    const pending = this.pendingFinalise;
    if (pending === null) return;
    this.pendingFinalise = null;

    this.physics.spawnBall();
    this.syncBall();
    this.fielding.reset();
    if (pending.contextChanged) {
      this.running.reset(); // innings switch / tiebreak / game over: no parked carry-over
    }
    if (pending.inningsChanged) {
      // Substitution caps are per innings (spec §4); layouts and bench persist.
      this.positioning?.A.resetSubs();
      this.positioning?.B.resetSubs();
      this.syncPositioning();
    }
    this.syncRunners();
    this.syncFielders();
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
