import { MapSchema, Schema, type } from '@colyseus/schema';
import type { MatchPhase } from '@carlquest/shared';

export class BallSchema extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') vx = 0;
  @type('number') vy = 0;
  @type('number') vz = 0;
  @type('number') wx = 0;
  @type('number') wy = 0;
  @type('number') wz = 0;
}

/** Mirrors FieldingModule's FielderView (M4) — keyed by character id in MatchState.fielders. */
export class FielderSchema extends Schema {
  @type('string') id = '';
  @type('number') x = 0;
  @type('number') z = 0;
  @type('boolean') hasBall = false;
  @type('number') stamina = 0;
}

/**
 * Mirrors RunningModule's RunnerView (M4/M5). Colyseus schema numbers cannot
 * carry `null`, so `atPost = -1` is the "between posts" sentinel for the view's
 * `atPost: number | null`. In M5 there can be several live/parked runners at
 * once, so these are held in MatchState.runners (a MapSchema keyed by character
 * id) rather than a single field — one entry per runner RunningModule reports.
 */
export class RunnerSchema extends Schema {
  @type('string') id = '';
  @type('number') x = 0;
  @type('number') z = 0;
  @type('number') atPost = -1;
  @type('boolean') running = false;
  @type('boolean') out = false;
}

/**
 * Authoritative match state (M5). Phase, scores, innings and batting order are
 * mirrored here from the pure RulesModule each transition; the room owns
 * everything physical (ball, fielders, runners). Scores are in integer
 * HALF-ROUNDER units (a rounder = 2 halves) so the schema stays integer.
 */
export class MatchState extends Schema {
  @type('string') phase: MatchPhase = 'LOBBY';
  @type(BallSchema) ball = new BallSchema();
  @type('boolean') ballLive = false;
  @type({ map: FielderSchema }) fielders = new MapSchema<FielderSchema>();
  @type({ map: RunnerSchema }) runners = new MapSchema<RunnerSchema>();

  // --- Rules mirror (RulesModule.view) -------------------------------------
  /** Half-rounders banked by side A / B (a rounder = 2 halves). */
  @type('number') scoreHalvesA = 0;
  @type('number') scoreHalvesB = 0;
  /** 0-based innings slot over inningsCount*2; tiebreak plays keep the last index. */
  @type('number') inningsIndex = 0;
  /** Outs recorded by the batting side this innings (or this tiebreak play). */
  @type('number') outs = 0;
  /** Which side ('A' | 'B') is batting. */
  @type('string') battingSide = 'A';
  /** Character id up to bat this play ('' when none / between innings). */
  @type('string') currentBatterId = '';
  /** Character id bowling this play (fielding side slot 0; fixed in the M5 demo). */
  @type('string') currentPitcherId = '';
  /** True once the match is in sudden-death tiebreak. */
  @type('boolean') tiebreak = false;
  /** Winning side once GAME_OVER; '' until then. */
  @type('string') winner = '';

  /**
   * JSON-serialised PlayResolution (RulesModule.resolvePlay) for the last play —
   * cause, outs, score delta and batter. '' before the first resolved play.
   */
  @type('string') lastOutcome = '';
  /**
   * JSON-serialised structured rejection { message, phase, reason } for the last
   * phase-invalid / malformed message. Mirrors the broadcast so tests can poll
   * server state reliably (the broadcast is also sent to clients). '' initially.
   */
  @type('string') lastRejection = '';

  // --- M6 seats & room code -------------------------------------------------
  /** 4-letter room code from the creation options ('' if created without one, e.g. tests). */
  @type('string') roomCode = '';
  /** SessionIds seated as side A (creator/first join) and side B; '' while unseated. */
  @type('string') sessionA = '';
  @type('string') sessionB = '';
  @type('boolean') connectedA = false;
  @type('boolean') connectedB = false;
  /** True while a mid-game disconnect grace runs — the simulation is frozen. */
  @type('boolean') paused = false;
}
