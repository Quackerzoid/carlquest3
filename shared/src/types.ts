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
