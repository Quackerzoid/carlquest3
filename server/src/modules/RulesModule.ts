/**
 * RulesModule — the pure rounders state machine (spec §2 phases, §8 rules;
 * M5 rules-engine design, user decisions 1 & 4). No Colyseus, no Rapier, no
 * RNG, no wall-clock: given a play's physical outcome and per-runner settlement
 * facts it advances phase, innings, outs and score deterministically. The room
 * owns everything physical and simply calls the transition methods, turning a
 * `false` return into a rejection event and `null` from resolvePlay likewise.
 *
 * Scoring is in integer HALF-ROUNDER units (a rounder = 2 halves) so schema and
 * tests stay integer (design §1). Only a runner's OWN hit can bank:
 *   - own-hit, home this play        → 2 halves (a rounder; the ½ is subsumed)
 *   - own-hit, post ≥ 2, not home     → 1 half   (a half-rounder, at play end)
 *   - anything else / later completion → 0
 * (User decision 1.) An out runner banks nothing even if they reached post ≥ 2.
 */
import { CONST, type Character, type PlayOutcome, type PlayResolution, type SettlementFact, type TeamSide } from '@carlquest/shared';

/**
 * Structural rules constants — NOT tunables (design §1 expects no new CONST
 * entries): they define the scoring unit and circuit shape themselves, so they
 * live here rather than in CONST.GAME. HOME_POST is derived from the pinned post
 * count so the two can never drift.
 */
const HALVES_PER_ROUNDER = 2; // a rounder scores two half-rounders (user decision 1)
const HALVES_PER_HALF_ROUNDER = 1;
const HALF_ROUNDER_MIN_POST = 2; // reaching the 2nd post on your own hit banks a half (user decision 1)
const SIDES = 2; // two teams (A, B) alternate innings within each pair
const PRESSURE_RUNNER_THRESHOLD = 2; // runners on 2+ posts raise the stakes (design §5, spec pressureMult)

export interface RulesConfig {
  /** Batting order = array order. */
  squadA: Character[];
  squadB: Character[];
  /** Number of A/B innings pairs; defaults to CONST.GAME.INNINGS_COUNT. */
  inningsCount?: number;
}

export interface RulesView {
  phase: import('@carlquest/shared').MatchPhase;
  battingSide: TeamSide;
  /** 0-based over inningsCount*2 slots; tiebreak plays keep the last index. */
  inningsIndex: number;
  scoreHalves: { A: number; B: number };
  /** Batting side, this innings (or this tiebreak play). */
  outs: number;
  currentBatterId: string | null;
  tiebreak: boolean;
  /** null until GAME_OVER; 'draw' never persists (a tie triggers tiebreak instead). */
  winner: TeamSide | 'draw' | null;
  /** Remaining batting queue, front first (excludes the current batter). */
  queue: string[];
}

export function createRulesModule(cfg: RulesConfig): {
  view(): RulesView;
  bothConnected(): boolean;
  completeDraft(squads?: { squadA: Character[]; squadB: Character[] }): boolean;
  confirmPositioning(): boolean;
  readyForPlay(): boolean;
  resolvePlay(cause: PlayOutcome, facts: SettlementFact[]): PlayResolution | null;
  rematch(): boolean;
  isFinalInnings(): boolean;
  pressure(runnersOnPosts: number): boolean;
  setNextBatter(id: string): boolean;
} {
  const inningsCount = cfg.inningsCount ?? CONST.GAME.INNINGS_COUNT;
  const totalSlots = inningsCount * SIDES; // A,B repeated inningsCount times
  const squadIds: Record<TeamSide, string[]> = {
    A: cfg.squadA.map((c) => c.id),
    B: cfg.squadB.map((c) => c.id),
  };

  let phase: import('@carlquest/shared').MatchPhase = 'LOBBY';
  let inningsIndex = 0;
  let battingSide: TeamSide = 'A';
  const scoreHalves: { A: number; B: number } = { A: 0, B: 0 };
  let outsCount = 0;
  /** Character ids out this innings (never re-enter the queue). */
  let outIds = new Set<string>();
  /** Ids waiting to bat (front = next up); excludes the current batter, parked runners and out players. */
  let queue: string[] = [];
  let currentBatterId: string | null = null;
  let tiebreak = false;
  /** Completed tiebreak plays; a pair (2 plays) completes on each even count. */
  let tiebreakPlays = 0;
  /** Per-side rotating batter pointer through the tiebreak, so each side keeps cycling its order. */
  const tiebreakBatterIdx: Record<TeamSide, number> = { A: 0, B: 0 };
  let winner: TeamSide | 'draw' | null = null;

  /** The batting side for a regular slot: even = A, odd = B. */
  function sideForSlot(slot: number): TeamSide {
    return slot % SIDES === 0 ? 'A' : 'B';
  }

  /** Begin a regular innings: fresh queue/outs, first batter up. */
  function startInnings(slot: number): void {
    inningsIndex = slot;
    battingSide = sideForSlot(slot);
    queue = [...squadIds[battingSide]];
    outIds = new Set();
    outsCount = 0;
    currentBatterId = queue.shift() ?? null;
  }

  /** Set up the next sudden-death play: alternating side, one fresh batter, phase PRE_PLAY. */
  function setupTiebreakPlay(): void {
    battingSide = tiebreakPlays % SIDES === 0 ? 'A' : 'B';
    outIds = new Set();
    outsCount = 0;
    const order = squadIds[battingSide];
    currentBatterId = order.length > 0 ? order[tiebreakBatterIdx[battingSide] % order.length]! : null;
    phase = 'PRE_PLAY';
  }

  function enterTiebreak(): void {
    tiebreak = true;
    tiebreakPlays = 0;
    tiebreakBatterIdx.A = 0;
    tiebreakBatterIdx.B = 0;
    // inningsIndex stays at the last regular slot — tiebreak plays keep it.
    setupTiebreakPlay();
  }

  /** Decide the game after the final regular innings: winner, else tiebreak. */
  function finishRegularPlay(): void {
    if (scoreHalves.A !== scoreHalves.B) {
      winner = scoreHalves.A > scoreHalves.B ? 'A' : 'B';
      phase = 'GAME_OVER';
    } else {
      enterTiebreak();
    }
  }

  /**
   * A regular innings has ended (queue empty / all out). This is the transient
   * INNINGS_SWITCH: either start the next innings (sides swap by slot parity) or,
   * after the last slot, finish the game — leaving phase at PRE_PLAY or GAME_OVER
   * synchronously (the room broadcasts the momentary switch if it wants).
   */
  function switchInnings(): void {
    const next = inningsIndex + 1;
    if (next < totalSlots) {
      startInnings(next);
      phase = 'PRE_PLAY';
    } else {
      finishRegularPlay();
    }
  }

  /** Advance the tiebreak after one play resolves: rotate batter, complete pairs, decide or continue. */
  function advanceTiebreak(): void {
    tiebreakBatterIdx[battingSide] += 1;
    tiebreakPlays += 1;
    if (tiebreakPlays % SIDES === 0 && scoreHalves.A !== scoreHalves.B) {
      winner = scoreHalves.A > scoreHalves.B ? 'A' : 'B';
      phase = 'GAME_OVER';
      return;
    }
    setupTiebreakPlay();
  }

  /** Ids put out this play: caught → batter; runOut → its runner; plus any facts flagged out. */
  function computeOuts(cause: PlayOutcome, facts: SettlementFact[], batterId: string): Set<string> {
    const out = new Set<string>();
    if (cause.kind === 'caught') out.add(batterId); // the batter is caught out (cause.by is the fielder)
    else if (cause.kind === 'runOut') out.add(cause.runnerId);
    for (const f of facts) if (f.out) out.add(f.runnerId);
    return out;
  }

  /** Half-rounders banked this play — only own-hit, non-out runners can score. */
  function computeScore(facts: SettlementFact[], outThisPlay: Set<string>): number {
    let halves = 0;
    for (const f of facts) {
      if (outThisPlay.has(f.runnerId)) continue; // out runners (incl. a caught batter) bank nothing
      if (!f.ownHit) continue; // later-play completions and parked runners score 0
      if (f.home) halves += HALVES_PER_ROUNDER;
      else if (f.highestPost >= HALF_ROUNDER_MIN_POST) halves += HALVES_PER_HALF_ROUNDER;
    }
    return halves;
  }

  function bothConnected(): boolean {
    if (phase !== 'LOBBY') return false;
    phase = 'DRAFT';
    return true;
  }

  function completeDraft(squads?: { squadA: Character[]; squadB: Character[] }): boolean {
    if (phase !== 'DRAFT') return false;
    if (squads !== undefined) {
      // M7: the real draft replaces the construction-time squads at the moment
      // the DRAFT phase closes (batting order = array order = pick order).
      // startInnings(0) already ran at construction (against the placeholder
      // squads), so re-run it now the real squadIds are in so the queue/first
      // batter reflect pick order rather than the stale construction-time one.
      squadIds.A = squads.squadA.map((c) => c.id);
      squadIds.B = squads.squadB.map((c) => c.id);
      startInnings(inningsIndex);
    }
    phase = 'INITIAL_POSITIONING';
    return true;
  }

  function confirmPositioning(): boolean {
    if (phase !== 'INITIAL_POSITIONING') return false;
    phase = 'PRE_PLAY';
    return true;
  }

  function readyForPlay(): boolean {
    if (phase !== 'PRE_PLAY') return false;
    phase = 'PLAY';
    return true;
  }

  /**
   * Resolve a play. Runs in the transient PLAY_RESOLVE phase and, when the innings
   * ends, passes through the transient INNINGS_SWITCH — both are left synchronously,
   * so view() only ever exposes the settled phase (PRE_PLAY or GAME_OVER). The room
   * may broadcast the intermediate phases; here they are not surfaced.
   */
  function resolvePlay(cause: PlayOutcome, facts: SettlementFact[]): PlayResolution | null {
    if (phase !== 'PLAY') return null;
    // A play cannot resolve with no batter — the innings would already have switched.
    if (currentBatterId === null) return null;
    const batterId = currentBatterId;

    const outThisPlay = computeOuts(cause, facts, batterId);
    const scoreDeltaHalves = computeScore(facts, outThisPlay);
    scoreHalves[battingSide] += scoreDeltaHalves;
    const resolution: PlayResolution = {
      cause,
      outs: [...outThisPlay],
      scoreDeltaHalves,
      batterId,
    };

    if (tiebreak) {
      // Each sudden-death play is a self-contained one-shot: no queue, no parked
      // runners carried over. Record its outs, then advance the pair machine.
      outsCount = outThisPlay.size;
      advanceTiebreak();
      return resolution;
    }

    // Apply outs: leave the innings queue for good.
    for (const id of outThisPlay) {
      if (!outIds.has(id)) {
        outIds.add(id);
        outsCount += 1;
      }
      queue = queue.filter((q) => q !== id);
    }
    // Home, non-out runners rejoin the BACK of the queue to bat again.
    for (const f of facts) {
      if (f.home && !outThisPlay.has(f.runnerId)) queue.push(f.runnerId);
    }
    // The current batter, if neither out nor home, is now a parked runner
    // (tracked by RunningModule, not the queue) — simply not re-added.
    currentBatterId = queue.shift() ?? null;
    if (currentBatterId !== null) {
      phase = 'PRE_PLAY';
    } else {
      // Queue empty (all out, or survivors stranded on posts) → innings ends.
      switchInnings();
    }
    return resolution;
  }

  function rematch(): boolean {
    if (phase !== 'GAME_OVER') return false;
    scoreHalves.A = 0;
    scoreHalves.B = 0;
    tiebreak = false;
    tiebreakPlays = 0;
    tiebreakBatterIdx.A = 0;
    tiebreakBatterIdx.B = 0;
    winner = null;
    startInnings(0);
    phase = 'INITIAL_POSITIONING';
    return true;
  }

  /** The last A/B pair, or any tiebreak play — the CLUTCH_SWING hook window (M9). */
  function isFinalInnings(): boolean {
    return tiebreak || inningsIndex >= totalSlots - SIDES;
  }

  function pressure(runnersOnPosts: number): boolean {
    return isFinalInnings() || runnersOnPosts >= PRESSURE_RUNNER_THRESHOLD;
  }

  /**
   * Batting side picks the next batter (spec §4, M8 — 'choose next batter only').
   * Valid whenever a batter is up and `id` waits in the queue; the displaced
   * current batter returns to the FRONT of the queue (their turn is deferred,
   * not lost). Phase/role gating is the room's job.
   */
  function setNextBatter(id: string): boolean {
    if (currentBatterId === null) return false;
    const idx = queue.indexOf(id);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    queue.unshift(currentBatterId);
    currentBatterId = id;
    return true;
  }

  function view(): RulesView {
    return {
      phase,
      battingSide,
      inningsIndex,
      scoreHalves: { A: scoreHalves.A, B: scoreHalves.B },
      outs: outsCount,
      currentBatterId,
      tiebreak,
      winner,
      queue: [...queue],
    };
  }

  // Initialise innings 0 so the view is coherent from LOBBY onward.
  startInnings(0);

  return {
    view,
    bothConnected,
    completeDraft,
    confirmPositioning,
    readyForPlay,
    resolvePlay,
    rematch,
    isFinalInnings,
    pressure,
    setNextBatter,
  };
}
