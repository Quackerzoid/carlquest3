import { describe, expect, it } from 'vitest';
import { CONST, MATCH_PHASES } from '../src/index';

describe('constants', () => {
  describe('PHYSICS — spec §8b', () => {
    it('pins GRAVITY_Y to -9.81', () => {
      expect(CONST.PHYSICS.GRAVITY_Y).toBe(-9.81);
    });

    it('pins FIXED_TIMESTEP to 1/60', () => {
      expect(CONST.PHYSICS.FIXED_TIMESTEP).toBe(1 / 60);
    });

    it('pins ball radius to 0.036 m', () => {
      expect(CONST.PHYSICS.BALL_RADIUS).toBe(0.036);
    });

    it('pins ball mass to 0.16 kg', () => {
      expect(CONST.PHYSICS.BALL_MASS).toBe(0.16);
    });

    it('pins ball restitution to 0.4', () => {
      expect(CONST.PHYSICS.BALL_RESTITUTION).toBe(0.4);
    });

    it('pins ball linear damping to 0.05', () => {
      expect(CONST.PHYSICS.BALL_LINEAR_DAMPING).toBe(0.05);
    });

    it('pins ball angular damping to 0.02', () => {
      expect(CONST.PHYSICS.BALL_ANGULAR_DAMPING).toBe(0.02);
    });

    it('pins Magnus force coefficient to 0.0006', () => {
      expect(CONST.PHYSICS.MAGNUS_K).toBe(0.0006);
    });

    it('pins ground friction to 0.6', () => {
      expect(CONST.PHYSICS.GROUND_FRICTION).toBe(0.6);
    });

    it('pins the default ball release height to 1.0 m', () => {
      expect(CONST.PHYSICS.BALL_RELEASE_HEIGHT).toBe(1.0);
    });

    it('pins the ground collider thickness to 0.1 m', () => {
      expect(CONST.PHYSICS.GROUND_THICKNESS).toBe(0.1);
    });

    it('pins the sim catch-up clamp to 0.25 s', () => {
      expect(CONST.PHYSICS.SIM_MAX_CATCHUP).toBe(0.25);
    });
  });

  describe('GAME — spec §8b', () => {
    it('pins squad size to 9', () => {
      expect(CONST.GAME.SQUAD_SIZE).toBe(9);
    });

    it('pins bench size to 2', () => {
      expect(CONST.GAME.BENCH_SIZE).toBe(2);
    });

    it('pins innings count to 2', () => {
      expect(CONST.GAME.INNINGS_COUNT).toBe(2);
    });

    it('pins casual mode substitutions per innings to Infinity', () => {
      expect(CONST.GAME.SUBS_PER_INNINGS_CASUAL).toBe(Infinity);
    });

    it('pins ranked mode substitutions per innings to 3', () => {
      expect(CONST.GAME.SUBS_PER_INNINGS_RANKED).toBe(3);
    });

    it('pins minimum move distance to 2.5 m', () => {
      expect(CONST.GAME.MOVE_MIN).toBe(2.5);
    });

    it('pins maximum move distance to 8.0 m', () => {
      expect(CONST.GAME.MOVE_MAX).toBe(8.0);
    });

    it('pins minimum reach to 0.8 m', () => {
      expect(CONST.GAME.REACH_MIN).toBe(0.8);
    });

    it('pins maximum reach to 3.0 m', () => {
      expect(CONST.GAME.REACH_MAX).toBe(3.0);
    });

    it('pins minimum pitch speed to 12 m/s', () => {
      expect(CONST.GAME.PITCH_MIN).toBe(12);
    });

    it('pins maximum pitch speed to 30 m/s', () => {
      expect(CONST.GAME.PITCH_MAX).toBe(30);
    });

    it('pins minimum hit speed to 10 m/s', () => {
      expect(CONST.GAME.HIT_MIN).toBe(10);
    });

    it('pins maximum hit speed to 40 m/s', () => {
      expect(CONST.GAME.HIT_MAX).toBe(40);
    });

    it('pins maximum spin rate to 40 rad/s', () => {
      expect(CONST.GAME.SPIN_MAX_RADS).toBe(40);
    });

    it('pins base timing window to 0.25 s', () => {
      expect(CONST.GAME.BASE_TIMING_WINDOW).toBe(0.25);
    });

    it('pins base catch duration to 0.3 s', () => {
      expect(CONST.GAME.BASE_CATCH).toBe(0.3);
    });

    it('pins instinct weight to 0.4', () => {
      expect(CONST.GAME.INSTINCT_W).toBe(0.4);
    });

    it('pins reflex weight to 0.3', () => {
      expect(CONST.GAME.REFLEX_W).toBe(0.3);
    });

    it('pins bench stamina regeneration to 1 per play', () => {
      expect(CONST.GAME.BENCH_STAMINA_REGEN).toBe(1);
    });

    it('pins hit elevation clamp to -10..60 degrees', () => {
      expect(CONST.GAME.HIT_ELEVATION_MIN_DEG).toBe(-10);
      expect(CONST.GAME.HIT_ELEVATION_MAX_DEG).toBe(60);
    });

    it('pins pitch elevation cap to 20 degrees', () => {
      expect(CONST.GAME.PITCH_ELEVATION_MAX_DEG).toBe(20);
    });

    it('pins demo play-end tunables', () => {
      expect(CONST.GAME.PLAY_TIMEOUT_S).toBe(6);
      expect(CONST.GAME.BALL_REST_SPEED).toBe(0.1);
      expect(CONST.GAME.BALL_REST_TIME_S).toBe(1);
    });

    it('pins the pCatch approach-penalty weight to 0.35', () => {
      expect(CONST.GAME.APPROACH_W).toBe(0.35);
    });

    it('pins the approach-penalty reference speed to 30 m/s', () => {
      expect(CONST.GAME.APPROACH_REF_SPEED).toBe(30);
    });

    it('pins the gather-to-throw release delay to 0.5 s', () => {
      expect(CONST.GAME.THROW_RELEASE_DELAY_S).toBe(0.5);
    });

    it('pins the sprint stamina cost to 0.15 per second', () => {
      expect(CONST.GAME.SPRINT_STAMINA_COST_PER_S).toBe(0.15);
    });

    it('pins the throw stamina cost to 0.5', () => {
      expect(CONST.GAME.THROW_STAMINA_COST).toBe(0.5);
    });

    it('pins the maximum catchable ball height to 2.5 m', () => {
      expect(CONST.GAME.CATCH_HEIGHT_MAX).toBe(2.5);
    });
  });

  describe('FIELD — placeholder geometry (spec §8b)', () => {
    it('defines exactly four posts', () => {
      expect(CONST.FIELD.POSTS).toHaveLength(4);
    });

    it('ensures post height is positive', () => {
      expect(CONST.FIELD.POST_HEIGHT).toBeGreaterThan(0);
    });

    it('ensures post radius is positive', () => {
      expect(CONST.FIELD.POST_RADIUS).toBeGreaterThan(0);
    });

    it('ensures ground half-extent is positive', () => {
      expect(CONST.FIELD.GROUND_HALF_EXTENT).toBeGreaterThan(0);
    });

    it('ensures batting square size is positive', () => {
      expect(CONST.FIELD.BATTING_SQUARE_SIZE).toBeGreaterThan(0);
    });

    it('ensures bowling square size is positive', () => {
      expect(CONST.FIELD.BOWLING_SQUARE_SIZE).toBeGreaterThan(0);
    });

    it('pins the post run-out sensor radius to 0.5 m', () => {
      expect(CONST.FIELD.POST_SENSOR_RADIUS).toBe(0.5);
    });

    it('defines exactly nine fielding positions', () => {
      expect(CONST.FIELD.FIELDING_POSITIONS).toHaveLength(9);
    });

    it('places fielding slot 0 (the bowler) on the bowling square', () => {
      expect(CONST.FIELD.FIELDING_POSITIONS[0]).toEqual(CONST.FIELD.BOWLING_SQUARE);
    });

    it('keeps every fielding position finite', () => {
      for (const pos of CONST.FIELD.FIELDING_POSITIONS) {
        expect(Number.isFinite(pos.x)).toBe(true);
        expect(Number.isFinite(pos.z)).toBe(true);
      }
    });
  });

  describe('MATCH_PHASES', () => {
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
  });

  describe('immutability', () => {
    it('is deeply frozen', () => {
      expect(Object.isFrozen(CONST)).toBe(true);
      expect(Object.isFrozen(CONST.PHYSICS)).toBe(true);
      expect(Object.isFrozen(CONST.FIELD.POSTS)).toBe(true);
      expect(Object.isFrozen(CONST.FIELD.POSTS[0])).toBe(true);
      expect(Object.isFrozen(CONST.FIELD.FIELDING_POSITIONS)).toBe(true);
      expect(Object.isFrozen(CONST.FIELD.FIELDING_POSITIONS[0])).toBe(true);
      expect(Object.isFrozen(CONST.GAME)).toBe(true);
    });
  });
});
