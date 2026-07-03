# Milestone 2 — PhysicsModule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-side `PhysicsModule` wrapping a Rapier world (ball, ground, posts) that steps deterministically at fixed 1/60 s and curves spinning balls via Magnus force, proven by tolerance-based Vitest tests (spec §9.2 acceptance: spun pitch deviates laterally; ball bounces and damps plausibly).

**Architecture:** One new module `server/src/modules/PhysicsModule.ts` built by an async factory (`createPhysicsModule()` — Rapier WASM init). Param/state types (`PitchParams`, `HitParams`, `BallState`) live in `shared/src/types.ts`; three new tunables in `shared/src/constants.ts`. The ball is created once and repositioned; `step(dt)` accumulates and substeps at exactly `FIXED_TIMESTEP`, applying `F = MAGNUS_K · (ω × v)` before each substep. Design doc: `docs/superpowers/specs/2026-07-03-physics-module-design.md`.

**Tech Stack:** `@dimforge/rapier3d-compat` ^0.14 (server dependency — first Rapier usage in the repo), Vitest 2 (threads pool already pinned), TypeScript strict.

## Global Constraints

- TypeScript `strict: true`; no `any`, no `@ts-ignore` without a justifying comment.
- All tunables in `shared/src/constants.ts`; spec §6 values are already there and MUST be consumed, not re-declared: gravity −9.81, timestep 1/60, ball 0.036 m / 0.16 kg / restitution 0.4 / lin damp 0.05 / ang damp 0.02, `MAGNUS_K` 0.0006, ground friction 0.6.
- New constants added by this milestone (design decision, spec silent): `PHYSICS.BALL_RELEASE_HEIGHT = 1.0`, `PHYSICS.GROUND_THICKNESS = 0.1`, `FIELD.POST_SENSOR_RADIUS = 0.5`.
- Determinism: no `Date.now()`, no `Math.random()`, no wall-clock anywhere in the module; fixed-increment substepping only.
- Server-authoritative: this module is server-only; nothing in `/client` changes in this milestone.
- British English comments; conventional commits; TDD (failing test first) for every task.
- Node is not on the default shell PATH: prefix PowerShell commands with `$env:Path = 'C:\Program Files\nodejs;' + $env:Path; `.

## File Structure

```
shared/src/types.ts                 MODIFY: add PitchParams, HitParams, BallState
shared/src/constants.ts             MODIFY: add 3 new tunables
shared/test/constants.test.ts       MODIFY: pin the 3 new values
server/package.json                 MODIFY: add @dimforge/rapier3d-compat
server/src/modules/PhysicsModule.ts CREATE: the module (sole responsibility: physics world)
server/test/PhysicsModule.test.ts   CREATE: tolerance-based suite
```

---

### Task 1: Shared types + constants for physics

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/constants.ts`
- Test: `shared/test/constants.test.ts`

**Interfaces:**
- Consumes: existing `Vec3` in `shared/src/types.ts`.
- Produces: `PitchParams { origin?: Vec3; velocity: Vec3; angularVelocity: Vec3 }`, `HitParams { velocity: Vec3; angularVelocity: Vec3 }`, `BallState { position: Vec3; velocity: Vec3; angularVelocity: Vec3 }`; constants `CONST.PHYSICS.BALL_RELEASE_HEIGHT = 1.0`, `CONST.PHYSICS.GROUND_THICKNESS = 0.1`, `CONST.FIELD.POST_SENSOR_RADIUS = 0.5`. Task 2 imports all of these.

- [ ] **Step 1: Write the failing tests** — append inside the existing `PHYSICS constants` describe block in `shared/test/constants.test.ts`:

```ts
    it('pins the default ball release height to 1.0 m', () => {
      expect(CONST.PHYSICS.BALL_RELEASE_HEIGHT).toBe(1.0);
    });

    it('pins the ground collider thickness to 0.1 m', () => {
      expect(CONST.PHYSICS.GROUND_THICKNESS).toBe(0.1);
    });
```

and inside the FIELD describe block:

```ts
    it('pins the post run-out sensor radius to 0.5 m', () => {
      expect(CONST.FIELD.POST_SENSOR_RADIUS).toBe(0.5);
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run shared`
Expected: 3 new tests FAIL (properties undefined).

- [ ] **Step 3: Implement** — in `shared/src/constants.ts` add to the `PHYSICS` object (after `GROUND_FRICTION`):

```ts
  /** Cuboid ground half-thickness; top face sits at y = 0 (M2 design decision). */
  GROUND_THICKNESS: 0.1,
  /** Default ball spawn height above the bowling square (M2 design decision). */
  BALL_RELEASE_HEIGHT: 1.0,
```

and to the `FIELD` object (after `POST_RADIUS`):

```ts
  /** Run-out sensor cylinder radius around each post (M2 design decision). */
  POST_SENSOR_RADIUS: 0.5,
```

In `shared/src/types.ts` append:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run shared` — Expected: all pass (39 tests). Also `npx tsc --noEmit -p shared` — clean.

- [ ] **Step 5: Commit**

```bash
git add shared
git commit -m "feat(shared): physics param types and milestone 2 tunables"
```

---

### Task 2: PhysicsModule core (world, ground, ball, stepping, interface)

**Files:**
- Modify: `server/package.json` (add dependency `"@dimforge/rapier3d-compat": "^0.14.0"`; run `npm install` from repo root after editing; if ^0.14 does not exist on npm, use the latest stable 0.x and record the version in your report)
- Create: `server/src/modules/PhysicsModule.ts`
- Test: `server/test/PhysicsModule.test.ts`

**Interfaces:**
- Consumes: `CONST`, `PitchParams`, `HitParams`, `BallState`, `Vec3` from `@carlquest/shared`.
- Produces: `createPhysicsModule(): Promise<PhysicsModule>` and `interface PhysicsModule { spawnBall(position?: Vec3): void; applyPitch(params: PitchParams): void; applyHit(params: HitParams): void; step(dtSeconds: number): void; getBallState(): BallState; isBallAtPost(postIndex: number): boolean; dispose(): void }` — Tasks 3 and 4 extend the SAME file and suite; Milestone 3 consumes the factory.

- [ ] **Step 1: Write the failing tests** — create `server/test/PhysicsModule.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server`
Expected: FAIL — cannot resolve `../src/modules/PhysicsModule`. (MatchRoom suite still passes.)

- [ ] **Step 3: Implement** — create `server/src/modules/PhysicsModule.ts`:

```ts
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

  return {
    spawnBall(position?: Vec3): void {
      placeBall(
        position ?? { x: FIELD.BOWLING_SQUARE.x, y: PHYSICS.BALL_RELEASE_HEIGHT, z: FIELD.BOWLING_SQUARE.z },
      );
    },

    applyPitch(params: PitchParams): void {
      this.spawnBall(params.origin);
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server` — Expected: all PhysicsModule tests pass (plus the 2 MatchRoom tests). `npx tsc --noEmit -p server` — clean.

Note: if `expect(...).toEqual(before)` determinism/accumulator tests flake on float identity, that indicates a real non-determinism bug — investigate with systematic-debugging; do NOT loosen those assertions to tolerances.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): rapier physics module with deterministic fixed stepping"
```

---

### Task 3: Magnus acceptance test (spec §9.2)

**Files:**
- Test: `server/test/PhysicsModule.test.ts` (append a describe block; implementation already landed in Task 2)

**Interfaces:**
- Consumes: `createPhysicsModule`, `run` helper from the same test file.
- Produces: the milestone's acceptance evidence. No new production code expected — if these tests fail, fix `applyMagnus` in `server/src/modules/PhysicsModule.ts`, not the test.

- [ ] **Step 1: Write the acceptance tests** — append to the top-level describe in `server/test/PhysicsModule.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify** (these should pass immediately if Task 2's Magnus is correct — a failure here is an implementation bug)

Run: `npx vitest run server`
Expected: PASS. If a Magnus test fails, debug `applyMagnus` (cross-product component order is the usual culprit); the assertions themselves are the milestone acceptance and must not be weakened.

- [ ] **Step 3: Commit**

```bash
git add server/test/PhysicsModule.test.ts
git commit -m "test(server): magnus curve acceptance for milestone 2"
```

---

### Task 4: Post sensor behaviour

**Files:**
- Test: `server/test/PhysicsModule.test.ts` (append; `isBallAtPost` implementation already landed in Task 2)

**Interfaces:**
- Consumes: `createPhysicsModule`, `run` helper.
- Produces: verified sensor semantics for RunningModule (Milestone 4).

- [ ] **Step 1: Write the failing/verifying tests** — append:

```ts
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
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run server`
Expected: PASS (implementation exists from Task 2). A failure means sensor wiring is wrong — fix the module.

- [ ] **Step 3: Commit**

```bash
git add server/test/PhysicsModule.test.ts
git commit -m "test(server): post run-out sensor coverage"
```

---

### Task 5: Full verification, project log

**Files:**
- Modify: `CLAUDE.md` (§6)

- [ ] **Step 1:** Run `npm run check` — expected: typecheck ×3 clean, lint clean, all suites green (shared 39, server 2 + new physics suite).
- [ ] **Step 2:** Update CLAUDE.md §6.1 (milestone 2 state), §6.2 (new-constant decisions: BALL_RELEASE_HEIGHT 1.0, GROUND_THICKNESS 0.1, POST_SENSOR_RADIUS 0.5; Whale deferred to M4; rapier version used), §6.3 changelog entry with verification evidence.
- [ ] **Step 3:** Commit `docs: record milestone 2 completion in project log`; after merge to main, tag `m2-physics`.

---

## Self-Review Notes

- Spec coverage: §1 interface complete (spawnBall/applyPitch/applyHit/step/getBallState + sensor query); §6 config all consumed from CONST; §9.2 acceptance = Task 3 tests + Task 2 bounce test. Whale capsule deliberately deferred to M4 (design doc records this).
- Type consistency: `PitchParams`/`HitParams`/`BallState` defined Task 1, consumed Task 2 verbatim; `run` helper defined once in Task 2's test file and reused by Tasks 3-4.
- Known API risk: Rapier compat API drift (`intersectionPair`, `setMass`, `integrationParameters.dt`). Latitude: match the installed version's documented API, preserving the interface and the deterministic fixed-step + Magnus-per-substep invariants; record deviations.
