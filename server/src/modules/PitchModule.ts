/**
 * Converts pitcher stats + player input into initial ball velocities (spec §1).
 * Pure: all physics application happens in PhysicsModule.
 */
import {
  CONST,
  pitchSpeed,
  pitchSpin,
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
  const usable = isFiniteVec(aim) && Math.hypot(aim.x, aim.y, aim.z) > 1e-9 ? aim : defaultAim();
  const horizontal = Math.hypot(usable.x, usable.z);
  const maxY = horizontal * Math.tan(maxElevationDeg * DEG_TO_RAD);
  const cappedY = Math.min(usable.y, maxY);
  const length = Math.hypot(usable.x, cappedY, usable.z);
  return { x: usable.x / length, y: cappedY / length, z: usable.z / length };
}

export function resolvePitch(stats: StatBlock, input: PitchInput): PitchParams {
  const direction = normaliseAim(input.aim, GAME.PITCH_ELEVATION_MAX_DEG);
  const speed = pitchSpeed(stats.pitch);
  const spinScalar = Math.max(-1, Math.min(1, input.spinInput));
  return {
    origin: {
      x: FIELD.BOWLING_SQUARE.x,
      y: PHYSICS.BALL_RELEASE_HEIGHT,
      z: FIELD.BOWLING_SQUARE.z,
    },
    velocity: { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed },
    // Sidespin about the vertical axis; Magnus turns this into lateral curve.
    // curveMult stays 1 until CURVEBALL_MASTER (Milestone 9).
    angularVelocity: { x: 0, y: pitchSpin(stats.spin, 1) * spinScalar, z: 0 },
  };
}
