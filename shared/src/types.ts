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

/** The nine 1-10 stats every character carries (spec §3). */
export interface StatBlock {
  speed: number;
  reach: number;
  power: number;
  pitch: number;
  spin: number;
  stamina: number;
  reflex: number;
  instinct: number;
  nerve: number;
}

/** The eleven ability identifiers (spec §3); behaviour lands in Milestone 9. */
export type AbilityId =
  | 'CLUTCH_SWING'
  | 'CURVEBALL_MASTER'
  | 'LONG_REACH'
  | 'QUICK_DRAW'
  | 'CANNON_ARM'
  | 'SWITCH'
  | 'IMMOVABLE'
  | 'POWER_BASE'
  | 'BUTTERFINGERS'
  | 'POWERHOUSE'
  | 'WALL';

export interface Character {
  id: string;
  name: string;
  stats: StatBlock;
  ability: AbilityId;
}

/** Payload of the pitch message (spec §7): aim direction + sidespin scalar in [-1, 1]. */
export interface PitchInput {
  aim: Vec3;
  spinInput: number;
}

/** Payload of the swing message (spec §7): aim direction + sidespin scalar in [-1, 1]. */
export interface SwingInput {
  aim: Vec3;
  spinInput: number;
}
