# PhysicsModule Design — Milestone 2

Source of intent: `docs/design/spec.md` §1 (interface), §6 (Rapier config), §9.2 (acceptance). This document reconciles those with the Milestone 1 codebase; it does not re-specify what the spec already fixes.

## Purpose

A server-side module wrapping a Rapier world that owns the ball, ground and post colliders, steps deterministically at a fixed 1/60 s, and bends spinning balls via a Magnus force. It is consumed by later modules (Pitch/Hit feed it velocities; Fielding/Running read ball state; MatchRoom drives `step`).

## Scope

**In:** Rapier world (gravity 0,−9.81,0), ground, ball rigid body, four post cylinder colliders + per-post sensor volumes, Magnus force, the §1 interface (`spawnBall`, `applyPitch`, `applyHit`, `step`, `getBallState`), determinism, tolerance-based Vitest suite.

**Out (deferred):** The Whale `WALL` capsule (spec §6 says "active during fielding" — lands with FieldingModule, Milestone 4); run-out semantics on the post sensors (RunningModule, Milestone 4); any client rendering of the ball (Milestone 3's loop).

## Architecture

One new server module, `server/src/modules/PhysicsModule.ts`, plus shared param types.

- **Initialisation.** `@dimforge/rapier3d-compat` needs async WASM init. A module-level `createPhysicsModule(): Promise<PhysicsModule>` calls `RAPIER.init()` (idempotent) and builds the world. Consumers hold the resolved instance; nothing else in the codebase awaits Rapier.
- **World.** Gravity from `CONST.PHYSICS.GRAVITY_Y`; `integrationParameters.dt = FIXED_TIMESTEP`.
- **Ground.** Fixed rigid body with a cuboid collider (`GROUND_HALF_EXTENT × GROUND_THICKNESS × GROUND_HALF_EXTENT`, top face at y = 0), friction `GROUND_FRICTION`. A cuboid rather than an infinite half-space so the field has a real extent.
- **Posts.** Four fixed cylinder colliders at `CONST.FIELD.POSTS` (radius `POST_RADIUS`, height `POST_HEIGHT`), each with a co-located cylinder **sensor** collider (radius `POST_SENSOR_RADIUS`, same height) exposed by index for later run-out queries (`isBallAtPost(index): boolean` via intersection test).
- **Ball.** One dynamic rigid body, sphere radius `BALL_RADIUS`, explicit mass `BALL_MASS`, restitution `BALL_RESTITUTION`, linear/angular damping per constants, CCD enabled (a 30 m/s ball would tunnel thin colliders otherwise). Created once and repositioned by `spawnBall` rather than destroyed/recreated (stable handle, less GC).
- **Magnus.** Each fixed substep, before `world.step()`: `F = MAGNUS_K × (ω × v)`; `resetForces` then `addForce`. This is what curves spun pitches and hits.
- **Stepping.** `step(dtSeconds)` adds to an accumulator and runs whole 1/60 substeps (`while acc ≥ dt`), leaving the remainder. No wall-clock reads inside the module — the caller decides cadence, so simulation is reproducible.

## Interface (exact)

```ts
interface PitchParams { origin?: Vec3; velocity: Vec3; angularVelocity: Vec3; }
interface HitParams   { velocity: Vec3; angularVelocity: Vec3; }
interface BallState   { position: Vec3; velocity: Vec3; angularVelocity: Vec3; }

interface PhysicsModule {
  spawnBall(position?: Vec3): void;          // default: bowling square at BALL_RELEASE_HEIGHT
  applyPitch(params: PitchParams): void;     // spawn at origin (or default) + set velocities
  applyHit(params: HitParams): void;         // set velocities at current ball position
  step(dtSeconds: number): void;             // fixed 1/60 substeps with Magnus each substep
  getBallState(): BallState;
  isBallAtPost(postIndex: number): boolean;  // sensor intersection, for later modules
  dispose(): void;
}
```

`PitchParams`/`HitParams`/`BallState` live in `shared/src/types.ts` (they cross the module boundary and later the network boundary). Param shape decision: Pitch/Hit modules (M3) own converting stats+input into velocities; PhysicsModule only applies them.

## New constants (spec is silent; logged in CLAUDE.md §6.2)

- `PHYSICS.BALL_RELEASE_HEIGHT = 1.0` m — default spawn height at the bowling square.
- `PHYSICS.GROUND_THICKNESS = 0.1` m — cuboid ground half-height.
- `FIELD.POST_SENSOR_RADIUS = 0.5` m — run-out sensor cylinder radius.

## Error handling

- `applyHit`/`getBallState` before any `spawnBall`/`applyPitch`: the ball exists from construction (spawned at default), so no undefined states.
- `isBallAtPost` with an out-of-range index throws a `RangeError` (programmer error, fail fast).
- `step` with non-positive dt is a no-op (accumulator unchanged).

## Testing (Vitest, tolerance-based, all deterministic)

1. **Magnus acceptance (spec §9.2):** two identical pitches (same initial velocity toward the batter), one with pure backspin-free lateral spin (ω = (0, 40, 0)), one spinless. After N steps, the spun ball's lateral (x) displacement differs from the spinless ball's by > 0.3 m; the spinless ball's lateral drift is < 1 mm.
2. **Bounce plausibility:** drop from 2 m with no spin; ball bounces (upward velocity after first ground contact), successive bounce apexes decrease, first-apex/drop-height ratio within (0.05, 0.4) — restitution 0.4 ⇒ ideal e² = 0.16, wide tolerance for damping/contact solver.
3. **Damping:** a rolling/flying ball's speed and spin magnitude strictly decrease over time in free flight (linear + angular damping active).
4. **Determinism:** two freshly-created modules given the identical pitch + step sequence produce identical `getBallState()` (exact float equality) after 300 steps.
5. **Interface behaviour:** `spawnBall` default position = bowling square at release height; `applyPitch` with explicit origin overrides; `step(0)`/negative dt leaves state unchanged; `isBallAtPost` true when ball placed inside a sensor, false outside; out-of-range index throws.

Physics assertions use tolerances; determinism uses exact equality (same binary, same op order).

## Verification

`npm run check` green across workspaces; new suite `server/test/PhysicsModule.test.ts` passing. Milestone acceptance = test 1 (curving pitch) + test 2 (plausible bounce) green, per spec §9.2.
