import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONST } from '@carlquest/shared';
import { createPhysicsModule, type PhysicsModule } from '../src/modules/PhysicsModule';

const DT = CONST.PHYSICS.FIXED_TIMESTEP;

/** Steps the module one fixed increment at a time for `seconds` of simulated time. */
function run(physics: PhysicsModule, seconds: number): void {
  const substeps = Math.round(seconds / DT);
  for (let i = 0; i < substeps; i += 1) physics.step(DT);
}

describe('PhysicsModule', () => {
  let physics: PhysicsModule;

  beforeEach(async () => {
    physics = await createPhysicsModule();
  });

  afterEach(() => {
    physics.dispose();
  });

  describe('spawn and state', () => {
    it('spawns the ball at the bowling square at release height by default', () => {
      physics.spawnBall();
      const { position } = physics.getBallState();
      expect(position.x).toBeCloseTo(CONST.FIELD.BOWLING_SQUARE.x, 6);
      expect(position.y).toBeCloseTo(CONST.PHYSICS.BALL_RELEASE_HEIGHT, 6);
      expect(position.z).toBeCloseTo(CONST.FIELD.BOWLING_SQUARE.z, 6);
    });

    it('spawnBall zeroes velocities from a previous flight', () => {
      physics.applyPitch({ velocity: { x: 5, y: 2, z: -10 }, angularVelocity: { x: 0, y: 30, z: 0 } });
      run(physics, 0.2);
      physics.spawnBall({ x: 1, y: 2, z: 3 });
      const state = physics.getBallState();
      expect(state.position).toEqual({ x: 1, y: 2, z: 3 });
      expect(state.velocity).toEqual({ x: 0, y: 0, z: 0 });
      expect(state.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('applyPitch spawns at the given origin and sets velocities', () => {
      physics.applyPitch({
        origin: { x: 0, y: 1.5, z: 5 },
        velocity: { x: 0, y: 0, z: -20 },
        angularVelocity: { x: 0, y: 40, z: 0 },
      });
      const state = physics.getBallState();
      expect(state.position).toEqual({ x: 0, y: 1.5, z: 5 });
      expect(state.velocity).toEqual({ x: 0, y: 0, z: -20 });
      expect(state.angularVelocity).toEqual({ x: 0, y: 40, z: 0 });
    });

    it('applyHit replaces velocities without moving the ball', () => {
      physics.spawnBall({ x: 0, y: 0.5, z: 0 });
      physics.applyHit({ velocity: { x: 3, y: 8, z: 15 }, angularVelocity: { x: 0, y: 0, z: 10 } });
      const state = physics.getBallState();
      expect(state.position).toEqual({ x: 0, y: 0.5, z: 0 });
      expect(state.velocity).toEqual({ x: 3, y: 8, z: 15 });
    });
  });

  describe('stepping', () => {
    it('gravity pulls a spawned ball downwards', () => {
      physics.spawnBall({ x: 0, y: 5, z: 0 });
      run(physics, 0.5);
      const { position, velocity } = physics.getBallState();
      expect(position.y).toBeLessThan(5);
      expect(velocity.y).toBeLessThan(0);
    });

    it('step with zero or negative dt leaves state untouched', () => {
      physics.spawnBall({ x: 0, y: 5, z: 0 });
      const before = physics.getBallState();
      physics.step(0);
      physics.step(-1);
      expect(physics.getBallState()).toEqual(before);
    });

    it('accumulates partial dt into whole fixed substeps', () => {
      physics.spawnBall({ x: 0, y: 5, z: 0 });
      // 40 calls of half a timestep = 20 whole substeps exactly
      for (let i = 0; i < 40; i += 1) physics.step(DT / 2);
      const twin = physics.getBallState();

      physics.spawnBall({ x: 0, y: 5, z: 0 });
      run(physics, 20 * DT);
      // Same number of substeps from a fresh identical spawn: same trajectory
      expect(physics.getBallState()).toEqual(twin);
    });
  });

  describe('bounce and damping plausibility (spec §9.2)', () => {
    it('bounces off the ground with decreasing apexes', () => {
      const drop = 2;
      physics.spawnBall({ x: 0, y: drop, z: 0 });
      let bounced = false;
      let apex1 = 0;
      let descending = true;
      for (let t = 0; t < 3; t += DT) {
        physics.step(DT);
        const { position, velocity } = physics.getBallState();
        if (descending && velocity.y > 0.01) {
          bounced = true;
          descending = false;
        }
        if (!descending) {
          if (position.y > apex1) apex1 = position.y;
          if (velocity.y < -0.01 && apex1 > 0) break; // apex recorded, descending again
        }
      }
      expect(bounced).toBe(true);
      // Restitution 0.4 => ideal apex ratio e^2 = 0.16; wide tolerance for solver/damping
      expect(apex1 / drop).toBeGreaterThan(0.05);
      expect(apex1 / drop).toBeLessThan(0.4);
    });

    it('linear and angular damping bleed speed and spin in free flight', () => {
      physics.applyPitch({
        origin: { x: 0, y: 50, z: 0 },
        velocity: { x: 10, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 30 },
      });
      run(physics, 1);
      const { velocity, angularVelocity } = physics.getBallState();
      expect(velocity.x).toBeGreaterThan(0);
      expect(velocity.x).toBeLessThan(10);
      const spin = Math.hypot(angularVelocity.x, angularVelocity.y, angularVelocity.z);
      expect(spin).toBeLessThan(30);
      expect(spin).toBeGreaterThan(0);
    });
  });

  describe('determinism', () => {
    it('two identical modules produce bit-identical trajectories', async () => {
      const twin = await createPhysicsModule();
      const pitch = {
        velocity: { x: 1.5, y: 3, z: -18 },
        angularVelocity: { x: 5, y: 25, z: -3 },
      };
      physics.applyPitch(pitch);
      twin.applyPitch(pitch);
      run(physics, 300 * DT);
      run(twin, 300 * DT);
      expect(physics.getBallState()).toEqual(twin.getBallState());
      twin.dispose();
    });
  });

  describe('Magnus curve (spec §9.2 acceptance)', () => {
    const pitchVelocity = { x: 0, y: 0, z: -20 }; // bowling square towards the batter

    it('a spinless pitch flies straight (no lateral drift)', () => {
      physics.applyPitch({ velocity: pitchVelocity, angularVelocity: { x: 0, y: 0, z: 0 } });
      run(physics, 0.35); // aloft the whole time from 1 m release
      const { position } = physics.getBallState();
      expect(Math.abs(position.x - CONST.FIELD.BOWLING_SQUARE.x)).toBeLessThan(1e-6);
    });

    it('a spun pitch deviates laterally from the spinless trajectory', () => {
      physics.applyPitch({ velocity: pitchVelocity, angularVelocity: { x: 0, y: 0, z: 0 } });
      run(physics, 0.35);
      const straightX = physics.getBallState().position.x;

      physics.applyPitch({
        velocity: pitchVelocity,
        angularVelocity: { x: 0, y: CONST.GAME.SPIN_MAX_RADS, z: 0 }, // max sidespin
      });
      run(physics, 0.35);
      const curvedX = physics.getBallState().position.x;

      // MAGNUS_K 0.0006 * (40 rad/s x 20 m/s) on 0.16 kg ~= 3 m/s^2 lateral;
      // over 0.35 s that is ~0.18 m. Assert a conservative floor.
      expect(Math.abs(curvedX - straightX)).toBeGreaterThan(0.1);
    });

    it('opposite spin curves the opposite way', () => {
      physics.applyPitch({
        velocity: pitchVelocity,
        angularVelocity: { x: 0, y: CONST.GAME.SPIN_MAX_RADS, z: 0 },
      });
      run(physics, 0.35);
      const rightX = physics.getBallState().position.x;

      physics.applyPitch({
        velocity: pitchVelocity,
        angularVelocity: { x: 0, y: -CONST.GAME.SPIN_MAX_RADS, z: 0 },
      });
      run(physics, 0.35);
      const leftX = physics.getBallState().position.x;

      expect(Math.sign(rightX - CONST.FIELD.BOWLING_SQUARE.x)).not.toBe(0);
      expect(Math.sign(rightX - CONST.FIELD.BOWLING_SQUARE.x)).toBe(
        -Math.sign(leftX - CONST.FIELD.BOWLING_SQUARE.x),
      );
    });
  });

  describe('post sensors', () => {
    it('detects the ball inside a post sensor volume', () => {
      const post = CONST.FIELD.POSTS[0];
      if (post === undefined) throw new Error('spec guarantees four posts');
      physics.spawnBall({ x: post.x, y: CONST.FIELD.POST_HEIGHT / 2, z: post.z });
      physics.step(DT); // sensors update on step
      expect(physics.isBallAtPost(0)).toBe(true);
      expect(physics.isBallAtPost(2)).toBe(false);
    });

    it('reports false once the ball has left the sensor', () => {
      const post = CONST.FIELD.POSTS[1];
      if (post === undefined) throw new Error('spec guarantees four posts');
      physics.spawnBall({ x: post.x, y: CONST.FIELD.POST_HEIGHT / 2, z: post.z });
      physics.step(DT);
      expect(physics.isBallAtPost(1)).toBe(true);
      physics.spawnBall({ x: post.x + 5, y: 1, z: post.z });
      physics.step(DT);
      expect(physics.isBallAtPost(1)).toBe(false);
    });

    it('throws RangeError for an out-of-range post index', () => {
      expect(() => physics.isBallAtPost(4)).toThrow(RangeError);
      expect(() => physics.isBallAtPost(-1)).toThrow(RangeError);
    });
  });

  describe('bounce tracking (spec §8 caught-before-bounce)', () => {
    it('hasBounced is false after spawnBall and while a pitch is airborne', () => {
      physics.spawnBall();
      expect(physics.hasBounced()).toBe(false);

      physics.applyPitch({ velocity: { x: 0, y: 2, z: -10 }, angularVelocity: { x: 0, y: 0, z: 0 } });
      expect(physics.hasBounced()).toBe(false);
      run(physics, 0.1); // from 1 m release with upward velocity: still well aloft
      expect(physics.getBallState().position.y).toBeGreaterThan(CONST.PHYSICS.BALL_RADIUS * 2);
      expect(physics.hasBounced()).toBe(false);
    });

    it('becomes true once a dropped ball contacts the ground', () => {
      physics.spawnBall({ x: 0, y: 1, z: 0 });
      run(physics, 1); // free fall from 1 m lands in ~0.44 s
      expect(physics.hasBounced()).toBe(true);
    });

    it('registers a fast grazing bounce even when no end-of-substep pose touches the ground', () => {
      // 0.264 m of fall at 20 m/s down = contact ~0.013 s in, INSIDE the first
      // substep; the rebound (restitution 0.4 => ~8 m/s up) lifts the ball clear
      // again before the substep ends, so a pose poll would never see contact.
      physics.applyPitch({
        origin: { x: 0, y: 0.3, z: 0 },
        velocity: { x: 0, y: -20, z: 30 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      });
      run(physics, 0.25);
      expect(physics.getBallState().position.y).toBeGreaterThan(0.2); // airborne again at check time
      expect(physics.hasBounced()).toBe(true);
    });

    it('is reset by spawnBall, applyPitch and applyHit', () => {
      const bounce = (): void => {
        physics.spawnBall({ x: 0, y: 1, z: 0 });
        run(physics, 1);
        expect(physics.hasBounced()).toBe(true);
      };

      bounce();
      physics.spawnBall();
      expect(physics.hasBounced()).toBe(false);

      bounce();
      physics.applyPitch({ velocity: { x: 0, y: 0, z: -10 }, angularVelocity: { x: 0, y: 0, z: 0 } });
      expect(physics.hasBounced()).toBe(false);

      bounce();
      physics.applyHit({ velocity: { x: 0, y: 8, z: 15 }, angularVelocity: { x: 0, y: 0, z: 0 } });
      expect(physics.hasBounced()).toBe(false);
    });
  });

  describe('blockers', () => {
    // Capsule centred at y = 1 spanning y in [-0.2, 2.2]: a ground-level ball
    // rolling along x = 0 towards +z meets its front face at z ~ 3.66.
    const inPath = { x: 0, y: 1, z: 4 };
    const outOfPath = { x: 20, y: 1, z: 4 };
    const HALF_HEIGHT = 0.9;
    const RADIUS = 0.3;

    /** Rolls the ball along the ground from the origin towards +z, past z = 4 if unobstructed. */
    function roll(): void {
      physics.spawnBall({ x: 0, y: CONST.PHYSICS.BALL_RADIUS, z: 0 });
      physics.applyHit({ velocity: { x: 0, y: 0, z: 10 }, angularVelocity: { x: 0, y: 0, z: 0 } });
      run(physics, 1.2);
    }

    it('a capsule blocker stops a rolling ball that passes unimpeded without one', () => {
      roll();
      expect(physics.getBallState().position.z).toBeGreaterThan(inPath.z);

      physics.setBlocker('whale', inPath, HALF_HEIGHT, RADIUS);
      roll();
      expect(physics.getBallState().position.z).toBeLessThan(inPath.z);
    });

    it('clearBlocker removes the obstacle and is a silent no-op for unknown ids', () => {
      physics.setBlocker('whale', inPath, HALF_HEIGHT, RADIUS);
      physics.clearBlocker('whale');
      roll();
      expect(physics.getBallState().position.z).toBeGreaterThan(inPath.z);

      expect(() => physics.clearBlocker('nobody')).not.toThrow();
    });

    it('setBlocker with an existing id repositions rather than duplicates', () => {
      physics.setBlocker('whale', inPath, HALF_HEIGHT, RADIUS);
      physics.setBlocker('whale', outOfPath, HALF_HEIGHT, RADIUS);
      roll();
      // A duplicate left at the old position would still block here.
      expect(physics.getBallState().position.z).toBeGreaterThan(inPath.z);

      physics.setBlocker('whale', inPath, HALF_HEIGHT, RADIUS);
      roll();
      expect(physics.getBallState().position.z).toBeLessThan(inPath.z);
    });

    it('a blocker contact does not set hasBounced (ground only)', () => {
      physics.setBlocker('whale', inPath, HALF_HEIGHT, RADIUS);
      physics.applyPitch({
        origin: { x: 0, y: 1, z: 0 },
        velocity: { x: 0, y: 0, z: 15 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      });
      run(physics, 0.3); // strikes the capsule at ~0.24 s, rebounds while still airborne
      const { position, velocity } = physics.getBallState();
      expect(velocity.z).toBeLessThan(0); // rebounded off the capsule
      expect(position.y).toBeGreaterThan(CONST.PHYSICS.BALL_RADIUS * 2); // never touched the ground
      expect(physics.hasBounced()).toBe(false);
    });
  });
});
