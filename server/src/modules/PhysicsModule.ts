import RAPIER from '@dimforge/rapier3d-compat';
import { CONST, type BallState, type HitParams, type PitchParams, type Vec3 } from '@carlquest/shared';

const { PHYSICS, FIELD } = CONST;

export interface PhysicsModule {
  /** Places the ball at rest; defaults to the bowling square at release height. */
  spawnBall(position?: Vec3): void;
  /** Spawns at params.origin (or default) and sets pitch velocities. */
  applyPitch(params: PitchParams): void;
  /** Replaces the ball's velocities at its current position (resolved swing). */
  applyHit(params: HitParams): void;
  /** Advances simulation in whole FIXED_TIMESTEP substeps; remainder accumulates. */
  step(dtSeconds: number): void;
  getBallState(): BallState;
  /** True while the ball intersects the run-out sensor of the given post (0-3). */
  isBallAtPost(postIndex: number): boolean;
  dispose(): void;
}

/** Builds the authoritative physics world. Await once; Rapier WASM init is idempotent. */
export async function createPhysicsModule(): Promise<PhysicsModule> {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: PHYSICS.GRAVITY_Y, z: 0 });
  world.integrationParameters.dt = PHYSICS.FIXED_TIMESTEP;

  // Ground: fixed cuboid with its top face at y = 0.
  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -PHYSICS.GROUND_THICKNESS, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(FIELD.GROUND_HALF_EXTENT, PHYSICS.GROUND_THICKNESS, FIELD.GROUND_HALF_EXTENT)
      .setFriction(PHYSICS.GROUND_FRICTION),
    groundBody,
  );

  // Ball: single dynamic body, repositioned rather than recreated.
  const ballBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(FIELD.BOWLING_SQUARE.x, PHYSICS.BALL_RELEASE_HEIGHT, FIELD.BOWLING_SQUARE.z)
      .setLinearDamping(PHYSICS.BALL_LINEAR_DAMPING)
      .setAngularDamping(PHYSICS.BALL_ANGULAR_DAMPING)
      .setCcdEnabled(true), // a 30 m/s ball tunnels thin colliders without CCD
  );
  const ballCollider = world.createCollider(
    RAPIER.ColliderDesc.ball(PHYSICS.BALL_RADIUS)
      .setRestitution(PHYSICS.BALL_RESTITUTION)
      // Rapier's default combine rule (Average) would blend this against the
      // ground's un-set (zero) restitution and halve the effective bounce, so
      // pin the ball's coefficient as the one that governs every contact.
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setMass(PHYSICS.BALL_MASS),
    ballBody,
  );

  // Posts: fixed cylinder + co-located run-out sensor per post.
  const postSensors: RAPIER.Collider[] = FIELD.POSTS.map((post) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(post.x, FIELD.POST_HEIGHT / 2, post.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(FIELD.POST_HEIGHT / 2, FIELD.POST_RADIUS),
      body,
    );
    return world.createCollider(
      RAPIER.ColliderDesc.cylinder(FIELD.POST_HEIGHT / 2, FIELD.POST_SENSOR_RADIUS).setSensor(true),
      body,
    );
  });

  let accumulator = 0;

  function placeBall(position: Vec3): void {
    ballBody.setTranslation(position, true);
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.resetForces(true);
    ballBody.resetTorques(true);
    accumulator = 0;
  }

  function applyMagnus(): void {
    const v = ballBody.linvel();
    const w = ballBody.angvel();
    // F = MAGNUS_K * (omega x v) — bends spinning balls (spec section 6).
    const force = {
      x: PHYSICS.MAGNUS_K * (w.y * v.z - w.z * v.y),
      y: PHYSICS.MAGNUS_K * (w.z * v.x - w.x * v.z),
      z: PHYSICS.MAGNUS_K * (w.x * v.y - w.y * v.x),
    };
    ballBody.resetForces(true);
    ballBody.addForce(force, true);
  }

  // Free function (not a method) so applyPitch can call it without a `this`
  // reference — inside the returned object literal `this` widens to
  // `PhysicsModule | PromiseLike<PhysicsModule>` under strict mode, which
  // TypeScript rejects (TS2339).
  function spawnBallAt(position?: Vec3): void {
    placeBall(
      position ?? { x: FIELD.BOWLING_SQUARE.x, y: PHYSICS.BALL_RELEASE_HEIGHT, z: FIELD.BOWLING_SQUARE.z },
    );
  }

  return {
    spawnBall(position?: Vec3): void {
      spawnBallAt(position);
    },

    applyPitch(params: PitchParams): void {
      spawnBallAt(params.origin);
      ballBody.setLinvel(params.velocity, true);
      ballBody.setAngvel(params.angularVelocity, true);
    },

    applyHit(params: HitParams): void {
      ballBody.setLinvel(params.velocity, true);
      ballBody.setAngvel(params.angularVelocity, true);
    },

    step(dtSeconds: number): void {
      if (dtSeconds <= 0) return;
      accumulator += dtSeconds;
      // Guard against float drift starving the last substep (e.g. 40 x dt/2).
      const EPSILON = 1e-9;
      while (accumulator >= PHYSICS.FIXED_TIMESTEP - EPSILON) {
        applyMagnus();
        world.step();
        accumulator -= PHYSICS.FIXED_TIMESTEP;
      }
    },

    getBallState(): BallState {
      const p = ballBody.translation();
      const v = ballBody.linvel();
      const w = ballBody.angvel();
      return {
        position: { x: p.x, y: p.y, z: p.z },
        velocity: { x: v.x, y: v.y, z: v.z },
        angularVelocity: { x: w.x, y: w.y, z: w.z },
      };
    },

    isBallAtPost(postIndex: number): boolean {
      const sensor = postSensors[postIndex];
      if (sensor === undefined) {
        throw new RangeError(`postIndex ${postIndex} out of range 0-${postSensors.length - 1}`);
      }
      return world.intersectionPair(sensor, ballCollider);
    },

    dispose(): void {
      world.free();
    },
  };
}
