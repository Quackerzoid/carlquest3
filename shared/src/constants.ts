/**
 * Single source of truth for every tunable number (spec §5, §6, §8b).
 * Field geometry is a Milestone-1 placeholder based on standard school
 * rounders layout — logged in CLAUDE.md §6.2, to be tuned in playtest.
 */

const PHYSICS = {
  GRAVITY_Y: -9.81,
  FIXED_TIMESTEP: 1 / 60,
  BALL_RADIUS: 0.036,
  BALL_MASS: 0.16,
  BALL_RESTITUTION: 0.4,
  BALL_LINEAR_DAMPING: 0.05,
  BALL_ANGULAR_DAMPING: 0.02,
  MAGNUS_K: 0.0006,
  GROUND_FRICTION: 0.6,
  /** Cuboid ground half-thickness; top face sits at y = 0 (M2 design decision). */
  GROUND_THICKNESS: 0.1,
  /** Default ball spawn height above the bowling square (M2 design decision). */
  BALL_RELEASE_HEIGHT: 1.0,
  /** Max seconds of unsimulated time a single tick may consume (spiral-of-death clamp). */
  SIM_MAX_CATCHUP: 0.25,
} as const;

/** Bowler stands here, facing the batter; doubles as fielding slot 0 so the two cannot drift. */
const BOWLING_SQUARE = { x: 0, z: 7.5 };

const FIELD = {
  /** Batter stands here; world origin. */
  BATTING_SQUARE: { x: 0, z: 0 },
  /** Bowler stands here, facing the batter. */
  BOWLING_SQUARE,
  /** Posts 1–4, run anticlockwise. Placeholder school-rounders layout. */
  POSTS: [
    { x: 11, z: 4 },
    { x: 9, z: 15 },
    { x: -3, z: 17 },
    { x: -8.5, z: 6 },
  ],
  POST_HEIGHT: 1.2,
  POST_RADIUS: 0.04,
  /** Half-extent of the square ground plane rendered in Milestone 1. */
  GROUND_HALF_EXTENT: 40,
  BATTING_SQUARE_SIZE: 2,
  BOWLING_SQUARE_SIZE: 2.5,
  /** Run-out sensor cylinder radius around each post (M2 design decision). */
  POST_SENSOR_RADIUS: 0.5,
  /**
   * Default nine fielding slots (M4 placeholder; real positioning lands in M8).
   * Slot 0 is the bowler (must equal BOWLING_SQUARE), slot 1 the backstop,
   * slots 2–5 mind posts 1–4, and slots 6–8 patrol the deep field.
   */
  FIELDING_POSITIONS: [
    BOWLING_SQUARE,
    { x: 0, z: -3 },
    { x: 12, z: 3 },
    { x: 10, z: 16 },
    { x: -4, z: 18 },
    { x: -9.5, z: 5 },
    { x: 16, z: 24 },
    { x: 3, z: 28 },
    { x: -12, z: 24 },
  ],
  /** Rectangular legal fielding area (spec §4); placeholder like the rest of the field geometry. */
  LEGAL_ZONE: { minX: -20, maxX: 20, minZ: -6, maxZ: 32 },
  /** Fielders must stay at least this far (m) from the batting square (spec §4). */
  BATTING_SQUARE_KEEPOUT: 3,
  /** The designated pitcher always stands here (spec §4); alias of the bowling square. */
  PITCHING_SPOT: BOWLING_SQUARE,
} as const;

const GAME = {
  SQUAD_SIZE: 9,
  BENCH_SIZE: 2,
  INNINGS_COUNT: 2,
  SUBS_PER_INNINGS_CASUAL: Infinity,
  SUBS_PER_INNINGS_RANKED: 3,
  MOVE_MIN: 2.5,
  MOVE_MAX: 8.0,
  REACH_MIN: 0.8,
  REACH_MAX: 3.0,
  PITCH_MIN: 12,
  PITCH_MAX: 30,
  HIT_MIN: 10,
  HIT_MAX: 40,
  SPIN_MAX_RADS: 40,
  BASE_TIMING_WINDOW: 0.25,
  BASE_CATCH: 0.3,
  INSTINCT_W: 0.4,
  REFLEX_W: 0.3,
  BENCH_STAMINA_REGEN: 1,
  /** Hit launch elevation clamp, degrees (M3 design decision, user-approved aim-based launch). */
  HIT_ELEVATION_MIN_DEG: -10,
  HIT_ELEVATION_MAX_DEG: 60,
  /** Pitch aim elevation cap, degrees (M3 design decision). */
  PITCH_ELEVATION_MAX_DEG: 20,
  /** Demo play ends after this long live, or when at rest (M3 design decisions). */
  PLAY_TIMEOUT_S: 6,
  BALL_REST_SPEED: 0.1,
  BALL_REST_TIME_S: 1,
  /** pCatch approach-penalty weight — fast-arriving balls are harder to catch (M4 design decision). */
  APPROACH_W: 0.35,
  /** Ball speed in m/s at which the approach penalty saturates (M4 design decision). */
  APPROACH_REF_SPEED: 30,
  /** Gather-to-throw release delay in seconds; QUICK_DRAW halves it in M9 (M4 design decision). */
  THROW_RELEASE_DELAY_S: 0.5,
  /** Stamina drained per second of fielder sprinting (M4 design decision). */
  SPRINT_STAMINA_COST_PER_S: 0.15,
  /** Stamina drained per throw (M4 design decision). */
  THROW_STAMINA_COST: 0.5,
  /** Balls above this height in metres are over everyone's head — no catch attempt (M4 design decision). */
  CATCH_HEIGHT_MAX: 2.5,
  /** Seconds a mid-game disconnected player may reconnect before the room disposes. */
  RECONNECT_GRACE_S: 60,
} as const;

/**
 * Ability tunables (spec §3, §9.9). All values are spec-literal except
 * SPIN_READ_W, which is a USER-APPROVED invented formula weight — the
 * spin-read penalty is SWITCH's counterpart mechanic and has no spec value.
 */
const ABILITY = {
  CLUTCH_POWER_BONUS: 3,
  CURVE_SPIN_MULT: 1.6,
  /** Fraction of flight-to-plane time before Magnus curve activates (CURVEBALL_MASTER). */
  CURVE_ONSET_FRACTION: 0.6,
  LONG_REACH_RADIUS_MULT: 1.4,
  /** m/s below which a fielder counts as "stationary" (LONG_REACH). */
  STATIONARY_SPEED_EPS: 0.1,
  QUICK_DRAW_DELAY_MULT: 0.5,
  CANNON_PITCH_BONUS: 3,
  CANNON_TIMING_WINDOW_MULT: 0.85,
  POWER_BASE_BONUS: 2,
  /** Max |timingError| in seconds for POWER_BASE's bonus to apply. */
  POWER_BASE_MAX_ERROR: 0.1,
  BUTTERFINGERS_FUMBLE_P: 0.35,
  POWERHOUSE_RADIUS_BONUS_M: 0.5,
  /** Stamina at/above which POWERHOUSE forces fatigueMult = 1. */
  POWERHOUSE_FATIGUE_FLOOR: 2,
  /** USER-APPROVED invented weight (M9 design doc §1): spin-read penalty = 1 - SPIN_READ_W·s01(spin)·|spinInput|. */
  SPIN_READ_W: 0.25,
} as const;

function deepFreeze<T extends object>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CONST = deepFreeze({ PHYSICS, FIELD, GAME, ABILITY });
