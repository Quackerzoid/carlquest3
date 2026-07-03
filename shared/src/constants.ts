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
} as const;

const FIELD = {
  /** Batter stands here; world origin. */
  BATTING_SQUARE: { x: 0, z: 0 },
  /** Bowler stands here, facing the batter. */
  BOWLING_SQUARE: { x: 0, z: 7.5 },
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
} as const;

function deepFreeze<T extends object>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CONST = deepFreeze({ PHYSICS, FIELD, GAME });
