/**
 * Resolves a batter swing against server-computed timing (spec §1, §5).
 * Pure: timing error is supplied by MatchRoom; physics application is PhysicsModule's.
 */
import {
  CONST,
  exitVelocity,
  hitSpin,
  pressureMult,
  timingFactor,
  timingWindow,
  type HitParams,
  type StatBlock,
  type SwingInput,
  type Vec3,
} from '@carlquest/shared';

const { GAME } = CONST;
const DEG_TO_RAD = Math.PI / 180;

export type SwingResult =
  | { contact: true; params: HitParams; timingFactor: number }
  | { contact: false };

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Default: a flat-ish drive towards mid-field, between posts 1 and 2. */
function defaultAim(): Vec3 {
  const p1 = GAMEFIELD_POST(0);
  const p2 = GAMEFIELD_POST(1);
  return { x: (p1.x + p2.x) / 2, y: 0, z: (p1.z + p2.z) / 2 };
}

function GAMEFIELD_POST(i: number): { x: number; z: number } {
  const post = CONST.FIELD.POSTS[i];
  if (post === undefined) throw new RangeError(`no post ${i}`);
  return post;
}

/** Normalise aim, clamping elevation to the tunable hit range (user-approved M3 decision). */
function normaliseAim(aim: Vec3): Vec3 {
  const finiteNonZero = isFiniteVec(aim) && Math.hypot(aim.x, aim.y, aim.z) > 1e-9;
  // A purely-vertical aim has zero horizontal component, which collapses the elevation
  // clamp and the final normalisation length below — treat it as degenerate too.
  const usable = finiteNonZero && Math.hypot(aim.x, aim.z) > 1e-9 ? aim : defaultAim();
  const horizontal = Math.hypot(usable.x, usable.z);
  const minY = horizontal * Math.tan(GAME.HIT_ELEVATION_MIN_DEG * DEG_TO_RAD);
  const maxY = horizontal * Math.tan(GAME.HIT_ELEVATION_MAX_DEG * DEG_TO_RAD);
  const clampedY = Math.min(maxY, Math.max(minY, usable.y));
  const length = Math.hypot(usable.x, clampedY, usable.z);
  return { x: usable.x / length, y: clampedY / length, z: usable.z / length };
}

export function resolveSwing(
  stats: StatBlock,
  input: SwingInput,
  timingError: number,
  windowMult = 1, // CANNON_ARM shrinks the batter's window in Milestone 9
  pressure = false, // RulesModule flags high-pressure states (Milestone 5, spec §5)
): SwingResult {
  const window = timingWindow(stats.reflex, windowMult);
  let timing = timingFactor(timingError, window);
  // NaN-safe: a degenerate window (e.g. windowMult 0) can make timingFactor NaN.
  // `!(timing > 0)` catches both `timing <= 0` and `NaN`, resolving to a miss either way.
  if (!(timing > 0)) return { contact: false };
  if (pressure) timing *= pressureMult(stats.nerve);

  const direction = normaliseAim(input.aim);
  const speed = exitVelocity(stats.power, timing);
  const spinScalar = Math.max(-1, Math.min(1, input.spinInput));
  return {
    contact: true,
    timingFactor: timing,
    params: {
      velocity: { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed },
      // hitCurveMult stays 1 until abilities (Milestone 9).
      angularVelocity: { x: 0, y: hitSpin(stats.spin, 1) * spinScalar, z: 0 },
    },
  };
}
