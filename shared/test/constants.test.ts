import { describe, expect, it } from 'vitest';
import { CONST, MATCH_PHASES } from '../src/index';

describe('constants', () => {
  it('defines the fixed physics timestep as exactly 1/60', () => {
    expect(CONST.PHYSICS.FIXED_TIMESTEP).toBe(1 / 60);
  });

  it('defines ball properties from spec §6', () => {
    expect(CONST.PHYSICS.BALL_RADIUS).toBe(0.036);
    expect(CONST.PHYSICS.BALL_MASS).toBe(0.16);
    expect(CONST.PHYSICS.BALL_RESTITUTION).toBe(0.4);
    expect(CONST.PHYSICS.MAGNUS_K).toBe(0.0006);
  });

  it('defines exactly four posts', () => {
    expect(CONST.FIELD.POSTS).toHaveLength(4);
  });

  it('orders match phases per spec §2', () => {
    expect(MATCH_PHASES).toEqual([
      'LOBBY',
      'DRAFT',
      'INITIAL_POSITIONING',
      'PRE_PLAY',
      'PLAY',
      'PLAY_RESOLVE',
      'INNINGS_SWITCH',
      'GAME_OVER',
    ]);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(CONST)).toBe(true);
    expect(Object.isFrozen(CONST.PHYSICS)).toBe(true);
  });
});
