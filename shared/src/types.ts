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

/**
 * Payload of the runDecision message — player stop/go runner control.
 * A user-approved deviation from spec §7 (M4 design decision): go = run on /
 * resume; stop = halt at the next post reached (posts are the only safe stops).
 */
export interface RunDecisionInput {
  go: boolean;
}

/** How a play resolved — the M4 subset of the spec §7 playOutcome; M5 adds half-rounder/no-ball. */
export type PlayOutcome =
  | { kind: 'caught'; by: string }
  | { kind: 'runOut'; atPost: number; runnerId: string } // atPost 1–4
  | { kind: 'safe'; atPost: number; runnerId: string } // atPost 0–4 (0 = batting square); runnerId = batter-runner of the play
  | { kind: 'rounder' };

/** A fielder and their starting slot — FieldingModule construction input (M4). */
export interface FielderSetup {
  character: Character;
  position: { x: number; z: number };
}

/** §7 draftPick message: the character the current picker takes. */
export interface DraftPickInput {
  id: string;
}

/** §7 setPitcher message (pulled forward from M8): the fielding side's nominated bowler. */
export interface SetPitcherInput {
  id: string;
}

/** Which of the two teams (M5 rules engine; draft/innings assignment lands elsewhere). */
export type TeamSide = 'A' | 'B';

/** RulesModule.resolvePlay() output for one play — the authoritative scoring/out record (M5). */
export interface PlayResolution {
  cause: PlayOutcome;
  /** Character ids put out this play. */
  outs: string[];
  /** Integer half-rounders banked this play. */
  scoreDeltaHalves: number;
  /** Who batted this play. */
  batterId: string;
}

/**
 * Per-runner facts RunningModule.settlePlay() reports and RulesModule.resolvePlay()
 * consumes. Lives in /shared so Tasks 2 and 3 (parallel) both import it from here,
 * not from each other.
 */
export interface SettlementFact {
  runnerId: string;
  ownHit: boolean;
  highestPost: number;
  home: boolean;
  out: boolean;
}
