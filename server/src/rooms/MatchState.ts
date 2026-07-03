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
 * Mirrors RunningModule's RunnerView (M4). Colyseus schema numbers cannot
 * carry `null`, so `atPost = -1` is the "between posts" sentinel for the
 * view's `atPost: number | null`; `id = ''` (with `running = false`, `out =
 * false`) is the "no runner in play" sentinel for the view being `null`.
 */
export class RunnerSchema extends Schema {
  @type('string') id = '';
  @type('number') x = 0;
  @type('number') z = 0;
  @type('number') atPost = -1;
  @type('boolean') running = false;
  @type('boolean') out = false;
}

export class MatchState extends Schema {
  @type('string') phase: MatchPhase = 'LOBBY';
  @type(BallSchema) ball = new BallSchema();
  @type('boolean') ballLive = false;
  /** Dev-visible log line for the M3+ demo (rejections, outcomes). Replaced by real events in M5+. */
  @type('string') demoLog = '';
  @type({ map: FielderSchema }) fielders = new MapSchema<FielderSchema>();
  @type(RunnerSchema) runner = new RunnerSchema();
  /**
   * JSON-serialised PlayOutcome (M4). A structured schema replaces this once
   * RulesModule owns scoring in M5 — logged in CLAUDE.md §6.2.
   */
  @type('string') lastOutcome = '';
}
