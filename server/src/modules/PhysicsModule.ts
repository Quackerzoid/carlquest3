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
  /**
   * True iff the ball has intersected the given post's run-out sensor at ANY
   * point since the last spawn/pitch/hit/clearPostCrossings. Event-accurate
   * (drained per substep), so it catches an intra-tick fly-through that the
   * once-per-tick isBallAtPost pose poll would miss — see CLAUDE.md §6.4.
   */
  wasBallAtPost(postIndex: number): boolean;
  /**
   * Discards all crossings latched so far without disturbing future event
   * capture. The room calls this when the runner's run-out exposure changes,
   * scoping wasBallAtPost to the CURRENT exposure window — a crossing that
   * predates the runner's exposure to a post must not run them out later.
   */
  clearPostCrossings(): void;
  /** True iff the ball has contacted the ground since the last spawn/pitch/hit. */
  hasBounced(): boolean;
  /**
   * Upserts a fixed capsule obstacle; an existing id is repositioned, never
   * duplicated. A flight that STARTS inside a blocker's capsule (the whale
   * throwing the ball he holds at his hands) is exempt from that blocker until
   * the ball first exits its footprint — never granted mid-flight, so a ball
   * on final approach is still blocked (M9 final-review fix).
   */
  setBlocker(id: string, position: Vec3, halfHeight: number, radius: number): void;
  /** Removes the blocker with this id; silent no-op for unknown ids. */
  clearBlocker(id: string): void;
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
  const groundCollider = world.createCollider(
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
      // Emit contact started/stopped events for bounce tracking. Purely
      // observational — nothing in the solver changes, so trajectories are
      // identical with or without it (pinned by the determinism test).
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setMass(PHYSICS.BALL_MASS),
    ballBody,
  );

  // Posts: fixed cylinder + co-located run-out sensor per post. Each sensor's
  // collider handle maps back to its post index so drained intersection events
  // can be attributed to the right post (event-accurate run-out, see step()).
  const postSensorIndexByHandle = new Map<number, number>();
  const postSensors: RAPIER.Collider[] = FIELD.POSTS.map((post, index) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(post.x, FIELD.POST_HEIGHT / 2, post.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(FIELD.POST_HEIGHT / 2, FIELD.POST_RADIUS),
      body,
    );
    const sensor = world.createCollider(
      RAPIER.ColliderDesc.cylinder(FIELD.POST_HEIGHT / 2, FIELD.POST_SENSOR_RADIUS)
        .setSensor(true)
        // Emit intersection started/stopped events so a fast fly-through that
        // clears the sensor between two once-per-tick polls is still captured.
        // The ball already flags COLLISION_EVENTS; setting it here too is
        // belt-and-braces and purely observational (no solver effect).
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    postSensorIndexByHandle.set(sensor.handle, index);
    return sensor;
  });

  // Blockers: fixed capsule obstacles keyed by caller id (spec §6, The Whale —
  // capability lands in M4, WALL wiring is M9). Fielders and runners are
  // deliberately logical entities, never Rapier bodies (M4 design doc), so the
  // ball stays this world's ONLY dynamic body and placeBall's accumulator reset
  // remains safe — closing the M2 caveat recorded in CLAUDE.md §6.2.
  interface BlockerEntry {
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    halfHeight: number;
    radius: number;
  }
  const blockers = new Map<string, BlockerEntry>();
  // Collider handles of all live blockers, for O(1) attribution when draining
  // contact events (WALL stop-dead, Milestone 9).
  const blockerColliderHandles = new Set<number>();
  // Blockers the CURRENT flight is exempt from (M9 final-review fix): a flight
  // released from INSIDE a blocker's capsule — the whale throwing the ball he
  // holds, parked at his hands — must not pin against his own blocker. The
  // exemption is granted ONLY at flight start (placeBall/applyHit evaluate
  // containment) and revoked — the collider re-enabled — the moment the ball
  // first exits the capsule footprint (checked per substep). A ball on final
  // approach is therefore never let through: its flight started outside.
  const exemptBlockerIds = new Set<string>();
  // Numeric guard, not a tunable: hysteresis so re-arming happens strictly
  // clear of the capsule surface rather than jittering on the boundary.
  const EXEMPT_CLEARANCE = 0.05;

  /** Ball centre strictly clear of the blocker capsule (segment distance, with hysteresis). */
  function ballClearOfBlocker(entry: BlockerEntry): boolean {
    const p = ballBody.translation();
    const c = entry.body.translation();
    const segY = Math.min(Math.max(p.y, c.y - entry.halfHeight), c.y + entry.halfHeight);
    const dist = Math.hypot(p.x - c.x, p.y - segY, p.z - c.z);
    return dist > entry.radius + PHYSICS.BALL_RADIUS + EXEMPT_CLEARANCE;
  }

  /**
   * New flight: any blocker whose capsule currently contains the ball is
   * disabled (exempt) for this flight; every other blocker is (re-)enabled.
   */
  function refreshFlightExemptions(): void {
    for (const [id, entry] of blockers) {
      const inside = !ballClearOfBlocker(entry);
      entry.collider.setEnabled(!inside);
      if (inside) exemptBlockerIds.add(id);
      else exemptBlockerIds.delete(id);
    }
  }

  // Drained every substep; `true` = auto-clear drained events.
  const eventQueue = new RAPIER.EventQueue(true);
  let bounced = false;
  // Post indices whose run-out sensor the ball has entered since the last
  // spawn/pitch/hit — latched from intersection events (see step()).
  const postsCrossed = new Set<number>();

  // Seconds remaining before Magnus is applied again (CURVEBALL_MASTER onset
  // gating, Milestone 9). Set from PitchParams.curveOnsetS in applyPitch;
  // always reset to 0 on a hit (hits curve immediately, spec/design decision).
  let curveOnsetRemaining = 0;

  let accumulator = 0;

  function placeBall(position: Vec3): void {
    ballBody.setTranslation(position, true);
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.resetForces(true);
    ballBody.resetTorques(true);
    bounced = false; // fresh flight — ground-contact tracking restarts
    postsCrossed.clear(); // and post-crossing tracking restarts for this segment
    curveOnsetRemaining = 0; // and any pending curve-onset gate (applyPitch re-sets it after)
    // Deliberate: re-anchor the substep phase to the spawn/pitch event, discarding
    // any sub-timestep remainder (<1/60 s) so trajectories are independent of when
    // the triggering message landed within a frame. The accumulator is WORLD time —
    // revisit before other dynamic bodies join this world (Milestone 4), as resetting
    // it on a pitch would then shift simulation time for every body. See CLAUDE.md §6.2.
    accumulator = 0;
    refreshFlightExemptions(); // a flight starting inside a blocker ignores it until first exit
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
      // CURVEBALL_MASTER onset gating (Milestone 9): Magnus is suppressed for
      // this many seconds of simulated flight. Fielding throws also go through
      // applyPitch but never set curveOnsetS, so this defaults to 0 (immediate
      // curve, today's behaviour) for them.
      curveOnsetRemaining = params.curveOnsetS ?? 0;
    },

    applyHit(params: HitParams): void {
      ballBody.setLinvel(params.velocity, true);
      ballBody.setAngvel(params.angularVelocity, true);
      // A hit keeps the ball's position (no placeBall), so restart bounce and
      // post-crossing tracking here explicitly: both are per play segment, and
      // a hit (like a throw via applyPitch) begins a fresh run-out window.
      bounced = false;
      postsCrossed.clear();
      // Hits always curve immediately: never leak a pitch's onset gate into
      // the following hit (spec/design decision, Task 2 brief).
      curveOnsetRemaining = 0;
      refreshFlightExemptions(); // a hit is a fresh flight too (see placeBall)
    },

    step(dtSeconds: number): void {
      if (dtSeconds <= 0) return;
      accumulator += dtSeconds;
      // Guard against float drift starving the last substep (e.g. 40 x dt/2).
      const EPSILON = 1e-9;
      while (accumulator >= PHYSICS.FIXED_TIMESTEP - EPSILON) {
        // CURVEBALL_MASTER onset gating (Milestone 9): while the gate is open,
        // skip Magnus entirely this substep instead of applying it — decrement
        // BEFORE the check so a fully-elapsed gate (remaining hits exactly 0)
        // already lets this substep curve. Deterministic: same fixed dt each
        // substep, so the countdown is identical across identical modules.
        curveOnsetRemaining = Math.max(0, curveOnsetRemaining - PHYSICS.FIXED_TIMESTEP);
        if (curveOnsetRemaining <= 0) applyMagnus();
        else ballBody.resetForces(true); // no Magnus contribution this substep
        world.step(eventQueue);
        // Event-accurate bounce detection (spec §8): a fast graze can contact
        // the ground BETWEEN end-of-substep poses, which a pose poll like
        // isBallAtPost would miss — see the known-issues note in CLAUDE.md §6.4.
        eventQueue.drainCollisionEvents((handle1, handle2, started) => {
          if (!started) return;
          const ball = ballCollider.handle;
          const ground = groundCollider.handle;
          if ((handle1 === ball && handle2 === ground) || (handle1 === ground && handle2 === ball)) {
            bounced = true;
            return;
          }
          // Post-sensor intersection: exactly one handle is the ball, the other
          // a post sensor. Latch the post so a mid-tick fly-through registers
          // even though the end-of-tick isBallAtPost poll has already moved on.
          const other = handle1 === ball ? handle2 : handle2 === ball ? handle1 : null;
          if (other === null) return;
          const postIndex = postSensorIndexByHandle.get(other);
          if (postIndex !== undefined) {
            postsCrossed.add(postIndex);
            return;
          }
          // Ball↔blocker CONTACT (WALL, Milestone 9): the ball "stops dead" —
          // both velocities are zeroed the substep the contact starts, undoing
          // any restitution rebound the solver just applied. Gravity is left
          // alone, so the stopped ball simply drops (spec §3 / M9 design doc).
          if (blockerColliderHandles.has(other)) {
            ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
          }
        });
        // Revoke flight exemptions the moment the ball is clear of the capsule
        // footprint: the blocker re-arms for the rest of the flight (M9 whale
        // own-throw fix — see the exemptBlockerIds declaration).
        for (const id of exemptBlockerIds) {
          const entry = blockers.get(id);
          if (entry === undefined) {
            exemptBlockerIds.delete(id);
          } else if (ballClearOfBlocker(entry)) {
            entry.collider.setEnabled(true);
            exemptBlockerIds.delete(id);
          }
        }
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

    wasBallAtPost(postIndex: number): boolean {
      if (postIndex < 0 || postIndex >= postSensors.length) {
        throw new RangeError(`postIndex ${postIndex} out of range 0-${postSensors.length - 1}`);
      }
      return postsCrossed.has(postIndex);
    },

    clearPostCrossings(): void {
      postsCrossed.clear();
    },

    hasBounced(): boolean {
      return bounced;
    },

    setBlocker(id: string, position: Vec3, halfHeight: number, radius: number): void {
      const existing = blockers.get(id);
      if (existing !== undefined) {
        existing.body.setTranslation(position, true); // reposition, never duplicate
        return;
      }
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.capsule(halfHeight, radius)
          // Emit contact events so step() can stop the ball dead on contact
          // (WALL, Milestone 9). Observational; the solver is unchanged.
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        body,
      );
      blockerColliderHandles.add(collider.handle);
      blockers.set(id, { body, collider, halfHeight, radius });
    },

    clearBlocker(id: string): void {
      const entry = blockers.get(id);
      if (entry === undefined) return;
      blockerColliderHandles.delete(entry.collider.handle);
      exemptBlockerIds.delete(id);
      world.removeRigidBody(entry.body); // attached colliders are removed with the body
      blockers.delete(id);
    },

    dispose(): void {
      eventQueue.free();
      world.free();
    },
  };
}
