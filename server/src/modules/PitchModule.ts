/**
 * Converts pitcher stats + player input into initial ball velocities (spec §1).
 * Pure: all physics application happens in PhysicsModule.
 */
import {
  CONST,
  NEUTRAL_PITCH_MODS,
  pitchSpeed,
  pitchSpin,
  type PitchAbilityMods,
  type PitchInput,
  type PitchParams,
  type StatBlock,
  type Vec3,
} from '@carlquest/shared';

const { FIELD, PHYSICS, GAME } = CONST;

const DEG_TO_RAD = Math.PI / 180;

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Default aim: from the bowling square towards the batting square at release height. */
function defaultAim(): Vec3 {
  return {
    x: FIELD.BATTING_SQUARE.x - FIELD.BOWLING_SQUARE.x,
    y: 0,
    z: FIELD.BATTING_SQUARE.z - FIELD.BOWLING_SQUARE.z,
  };
}

/** Normalise aim, capping elevation so pitches cannot be lobbed (player input is untrusted). */
function normaliseAim(aim: Vec3, maxElevationDeg: number): Vec3 {
  const finiteNonZero = isFiniteVec(aim) && Math.hypot(aim.x, aim.y, aim.z) > 1e-9;
  // A purely-vertical aim has zero horizontal component, which collapses the elevation
  // cap and the final normalisation length below — treat it as degenerate too.
  const usable = finiteNonZero && Math.hypot(aim.x, aim.z) > 1e-9 ? aim : defaultAim();
  const horizontal = Math.hypot(usable.x, usable.z);
  const maxY = horizontal * Math.tan(maxElevationDeg * DEG_TO_RAD);
  const cappedY = Math.min(usable.y, maxY);
  const length = Math.hypot(usable.x, cappedY, usable.z);
  return { x: usable.x / length, y: cappedY / length, z: usable.z / length };
}

/**
 * Estimated flight time (seconds) from the bowling square to the batting
 * square's z-plane, travelling along the normalised aim direction at the
 * given speed. Returns 0 if the aim never reaches the plane (moving away
 * from it, or with no horizontal component along the batting-square axis).
 */
function flightToPlaneSeconds(direction: Vec3, speed: number): number {
  if (speed <= 0) return 0;
  const distanceZ = FIELD.BATTING_SQUARE.z - FIELD.BOWLING_SQUARE.z;
  // The pitch travels from BOWLING_SQUARE towards BATTING_SQUARE; distanceZ
  // and direction.z must have the same sign for the aim to close on the plane.
  if (Math.abs(direction.z) < 1e-9 || Math.sign(direction.z) !== Math.sign(distanceZ)) return 0;
  const distance = Math.abs(distanceZ / direction.z) * Math.hypot(direction.x, direction.z);
  return distance / speed;
}

export function resolvePitch(
  stats: StatBlock,
  input: PitchInput,
  // Neutral default: identical output to the pre-M9 (no-ability) behaviour.
  mods: PitchAbilityMods = NEUTRAL_PITCH_MODS,
): PitchParams {
  const direction = normaliseAim(input.aim, GAME.PITCH_ELEVATION_MAX_DEG);
  const speed = pitchSpeed(stats.pitch + mods.pitchStatBonus);
  const spinScalar = Math.max(-1, Math.min(1, input.spinInput));
  const curveOnsetS = flightToPlaneSeconds(direction, speed) * mods.curveOnsetFraction;
  return {
    origin: {
      x: FIELD.BOWLING_SQUARE.x,
      y: PHYSICS.BALL_RELEASE_HEIGHT,
      z: FIELD.BOWLING_SQUARE.z,
    },
    velocity: { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed },
    // Sidespin about the vertical axis; Magnus turns this into lateral curve.
    angularVelocity: { x: 0, y: pitchSpin(stats.spin, mods.spinCurveMult) * spinScalar, z: 0 },
    ...(curveOnsetS > 0 ? { curveOnsetS } : {}),
  };
}
