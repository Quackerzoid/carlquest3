/** Match phases in spec §2 order. */
export const MATCH_PHASES = [
  'LOBBY',
  'DRAFT',
  'INITIAL_POSITIONING',
  'PRE_PLAY',
  'PLAY',
  'PLAY_RESOLVE',
  'INNINGS_SWITCH',
  'GAME_OVER',
] as const;

export type MatchPhase = (typeof MATCH_PHASES)[number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Velocities a pitch imparts to the ball; PitchModule computes these from stats (M3). */
export interface PitchParams {
  /** Spawn point; defaults to the bowling square at BALL_RELEASE_HEIGHT. */
  origin?: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
}

/** Velocities a resolved swing imparts to the ball at its current position. */
export interface HitParams {
  velocity: Vec3;
  angularVelocity: Vec3;
}

/** Authoritative ball kinematics snapshot. */
export interface BallState {
  position: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
}
