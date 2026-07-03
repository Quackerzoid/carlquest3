# Milestone 4 — FieldingModule + RunningModule Implementation Plan

> **For agentic workers:** execute task-by-task with TDD (failing test first, then implementation). Tasks 3 and 4 are parallel-safe (disjoint files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hit ball is contested: fielders chase (two-fielder pursuit), attempt stats-driven catches (one pCatch roll per radius entry), and throw to the runner's target post at `pitchSpeed`; the batter-runner runs the posts under player stop/go; the play resolves to `caught` / `runOut` / `safe` / `rounder` (spec §9.4 acceptance).

**Architecture:** Design doc: `docs/superpowers/specs/2026-07-03-fielding-running-design.md` — read it first; it records the four user decisions and all new tunables. `/shared` gains fielding/running types, `approachPenalty`, and a seeded RNG. PhysicsModule gains event-accurate bounce tracking and a blocker-capsule API. Two new server modules own fielder AI and runner state; MatchRoom orchestrates them per tick and emits the play outcome. Fielders/runner are **logical entities, not Rapier bodies** — this closes the M2 accumulator-reset caveat by design.

**Tech stack:** unchanged (no new dependencies).

## Global Constraints

- TypeScript `strict: true`; no `any` / `@ts-ignore` without a justifying comment.
- Every number from `CONST` — no magic numbers. §5 formulas used exactly (`moveSpeed`, `catchRadius`, `pCatch`, `fatigueMult`); `pressureMult` stays unused until M5 (no pressure states exist before innings/runner bookkeeping).
- Abilities are M9: neutral-default parameters only (`radiusMult = 1`, `guaranteed = false`, `fumbleChance = 0`, `releaseDelayMult = 1`). Do NOT implement ability conditions.
- Determinism: injected seeded RNG only (no `Math.random` in `/server` or `/shared`); no wall-clock.
- Server-authoritative; client renders and sends inputs only. British English. Conventional commits.
- Remote session note: work happens directly on branch `claude/hello-flphi2` (no worktree — single-branch remote environment; logged deviation).

## File Structure

```
shared/src/types.ts               MODIFY  +RunDecisionInput, PlayOutcome, FielderSetup
shared/src/constants.ts           MODIFY  +7 GAME tunables, +FIELD.FIELDING_POSITIONS
shared/src/formulas.ts            MODIFY  +approachPenalty
shared/src/rng.ts                 CREATE  mulberry32 createRng
shared/src/index.ts               MODIFY  re-export rng
shared/test/formulas.test.ts      MODIFY  +approachPenalty cases
shared/test/rng.test.ts           CREATE
shared/test/constants.test.ts     MODIFY  pin new tunables
server/src/modules/PhysicsModule.ts   MODIFY  +hasBounced, setBlocker/clearBlocker
server/test/PhysicsModule.test.ts     MODIFY  +bounce + blocker tests
server/src/modules/FieldingModule.ts  CREATE
server/test/FieldingModule.test.ts    CREATE
server/src/modules/RunningModule.ts   CREATE
server/test/RunningModule.test.ts     CREATE
server/src/rooms/MatchState.ts        MODIFY  +FielderSchema, RunnerSchema, lastOutcome
server/src/rooms/MatchRoom.ts         MODIFY  wire modules, runDecision, outcome resolution
server/test/MatchRoom.test.ts         MODIFY  +integration tests
client/src/RenderModule.ts            MODIFY  +fielder/runner meshes
client/src/InputModule.ts             MODIFY  +R/T keys
client/src/main.ts                    MODIFY  wire outcome display
TUNING.md                             CREATE  first-guess values noted
```

Task order: 1 → 2 → (3 ∥ 4) → 5 → 6 → 7. Task 2 only touches PhysicsModule and may run parallel with 1 if coordinated, but 3/4 import Task 1's contracts — land 1 first.

---

### Task 1: Shared contracts — types, tunables, approachPenalty, RNG

**Files:** modify `shared/src/{types,constants,formulas,index}.ts`, `shared/test/{formulas,constants}.test.ts`; create `shared/src/rng.ts`, `shared/test/rng.test.ts`.

**Produces (imported by later tasks from `@carlquest/shared`):**

```ts
export interface RunDecisionInput { go: boolean }               // §7 deviation, user-approved
export type PlayOutcome =
  | { kind: 'caught'; by: string }
  | { kind: 'runOut'; atPost: number }                          // 1–4
  | { kind: 'safe'; atPost: number }                            // 0–4 (0 = batting square)
  | { kind: 'rounder' };
export interface FielderSetup { character: Character; position: { x: number; z: number } }
export function approachPenalty(ballSpeed: number): number;     // APPROACH_W * clamp01(speed / APPROACH_REF_SPEED); negatives clamp to 0
export function createRng(seed: number): () => number;          // mulberry32, [0, 1)
```

**Constants:** `GAME.APPROACH_W = 0.35`, `GAME.APPROACH_REF_SPEED = 30`, `GAME.THROW_RELEASE_DELAY_S = 0.5`, `GAME.SPRINT_STAMINA_COST_PER_S = 0.15`, `GAME.THROW_STAMINA_COST = 0.5`, `GAME.CATCH_HEIGHT_MAX = 2.5`; `FIELD.FIELDING_POSITIONS`: 9 `{x, z}` slots — slot 0 = the bowling square; 8 more spread around/behind the post diamond (placeholder, M8 replaces). All deep-frozen via existing `CONST`.

**Steps:**
- [ ] Failing tests: approachPenalty pinned at speed 0 → 0, 15 → 0.175, 30 → 0.35, 60 → 0.35 (clamped), −5 → 0; rng same-seed identical 10-sequence, cross-seed differing, 1000 outputs ∈ [0,1); constants presence/values/frozen; FIELDING_POSITIONS length 9, slot 0 = BOWLING_SQUARE.
- [ ] Implement; `npm run check` green.

---

### Task 2: PhysicsModule — bounce tracking + blocker API

**Files:** modify `server/src/modules/PhysicsModule.ts`, `server/test/PhysicsModule.test.ts`.

**Interface additions:**

```ts
hasBounced(): boolean;                     // ground contact since last spawn/pitch/hit
setBlocker(id: string, position: Vec3, halfHeight: number, radius: number): void;  // static capsule; repositions if id exists
clearBlocker(id: string): void;            // no-op if absent
```

**Design:** create a `RAPIER.EventQueue(true)`; pass it to `world.step(eventQueue)`; drain collision events each substep — a started contact involving the ground collider and the ball sets `bounced = true`. `placeBall` (hence spawn/pitch/hit paths) resets it. Blockers: `Map<string, {body, collider}>` of fixed capsule bodies; `setBlocker` on an existing id teleports the body. Ball restitution combine rule already Max — a blocker stop-dead behaviour (WALL) is M9; here the capsule is just a physical obstacle. Keep the world's only dynamic body the ball (document: closes the M2 accumulator caveat).

**Steps:**
- [ ] Failing tests: `hasBounced()` false at spawn and mid-flight; true after a dropped ball hits ground (event-accurate: also true for a fast, low grazing bounce); reset by `spawnBall`, `applyPitch`, `applyHit`; blocker: rolling ball into a capsule directly ahead stops/rebounds (|z-velocity| direction reverses or speed drops), ball without blocker passes the same point; `clearBlocker` then same roll passes; `setBlocker` same id repositions rather than duplicating.
- [ ] Implement; all existing 16 physics tests must stay green (regression: determinism test unchanged); `npm run check` green.

---

### Task 3: FieldingModule (parallel-safe with Task 4)

**Files:** create `server/src/modules/FieldingModule.ts`, `server/test/FieldingModule.test.ts`.

**Interface:**

```ts
export interface FielderView {
  id: string; x: number; z: number; hasBall: boolean; stamina: number;
}
export interface FieldingDeps {
  rng: () => number;
  hasBounced: () => boolean;
  applyThrow: (params: PitchParams) => void;   // room binds physics.applyPitch
  holdBallAt: (pos: Vec3) => void;             // room binds physics.spawnBall
}
export type FieldingEvent =
  | { kind: 'caught'; by: string }             // pre-bounce catch (out)
  | { kind: 'gathered'; by: string }           // post-bounce pickup
  | { kind: 'thrown'; by: string; atPost: number };
export function createFieldingModule(setup: FielderSetup[], deps: FieldingDeps): {
  tick(dt: number, ball: BallState, ballLive: boolean, runnerTargetPost: number | null): FieldingEvent | null;
  getFielders(): FielderView[];
  holderId(): string | null;
  reset(): void;                                // back to setup positions, ball released, latches cleared
};
```

**Behaviour (from design doc):**
- Roles per tick: chaser = nearest to predicted gather point (airborne: gravity-only landing projection at y = BALL_RADIUS, Magnus ignored — comment the approximation; rolling: ball position). Cover = next-nearest, target = runner's target post + 0.5 m offset towards their own position; `runnerTargetPost === null` → nobody covers. Others hold.
- Movement at `moveSpeed(stats.speed, fatigueMult(stamina))`; movers drain `SPRINT_STAMINA_COST_PER_S * dt`, floored at 0; arrival within one frame's travel snaps to target.
- Catch: ball live, not held, `ball.position.y ≤ CATCH_HEIGHT_MAX`, 3D distance ≤ `catchRadius(stats.reach) * radiusMult(=1)`. Entry-latch per fielder: roll once on entry (`rng() < pCatch(instinct, reflex, approachPenalty(|v|))`), success → hold ball, return `caught` if `!hasBounced()` else `gathered`; failure → latched until the ball exits the radius.
- Held: module tracks holder + hold-time; each tick calls `holdBallAt(hands)` (hands = fielder pos at BALL_RELEASE_HEIGHT). After `THROW_RELEASE_DELAY_S`: if `runnerTargetPost !== null`, compute `throwVelocity(hands, postTop, pitchSpeed(stats.pitch))` (low ballistic solve; 45° fallback when out of range; null for degenerate geometry → hold and retry next tick), release via `applyThrow`, drain `THROW_STAMINA_COST`, return `thrown`. No runner between posts → keep holding (room ends play at rest/timeout).
- Export `throwVelocity` for direct testing.

**Steps:**
- [ ] Failing tests (seeded rng, hand-built BallState fixtures — no Rapier needed): chaser selection nearest-to-landing (airborne fixture) and nearest-to-ball (rolling); cover moves to runner target post, holds when no runner; movement distance per tick = moveSpeed·dt (stamina full), slows when stamina drained below 3 (fatigueMult); rng called exactly once on radius entry, zero while latched, again after exit/re-entry; forced catch (rng→0) pre-bounce → `caught`, post-bounce → `gathered`; forced miss (rng→0.999) → null event; high ball (y > CATCH_HEIGHT_MAX) → no roll; throw released only after THROW_RELEASE_DELAY_S, event `thrown` with correct post, `applyThrow` velocity magnitude = pitchSpeed(stats.pitch) (± ε) pointed toward the post, stamina −THROW_STAMINA_COST; `throwVelocity` solve hits a 10 m target within 0.2 m under gravity-only integration, 45° fallback beyond range, null at zero distance; `reset()` restores positions and clears holder/latches.
- [ ] Implement; `npm run check` green.

---

### Task 4: RunningModule (parallel-safe with Task 3)

**Files:** create `server/src/modules/RunningModule.ts`, `server/test/RunningModule.test.ts`.

**Interface:**

```ts
export interface RunnerView {
  id: string; x: number; z: number;
  atPost: number | null;        // 0 = batting square, 1–4; null while between posts
  targetPost: number | null;    // post being run to; null when stationary
  out: boolean; home: boolean;  // home = reached post 4
}
export function createRunningModule(): {
  startRun(character: Character): void;         // spawn at batting square, auto-run to post 1
  setDecision(go: boolean): void;               // design-doc semantics (stop = at next post)
  tick(dt: number): void;
  markOut(): void;
  runner(): RunnerView | null;
  /** Post the runner is mid-segment towards (run-out exposure); null at a post/stationary. */
  exposedPost(): number | null;
  reset(): void;
};
```

**Behaviour:** path = `BATTING_SQUARE → POSTS[0..3]`, straight segments, advance at `moveSpeed(stats.speed, fatigueMult(stats.stamina))` (runner stamina static in M4 — one play; drain lands with multi-play innings in M5, noted). `startRun` auto-runs (decision: hitting commits the runner; player may stop before post 1). Stop arms halt-at-next-post; go from a post resumes; go mid-segment clears an armed stop. Post 4 arrival → `home = true` (room maps to `rounder`). Overshoot within a tick snaps to the post.

**Steps:**
- [ ] Failing tests: startRun spawns at batting square running to post 1; position after t seconds = distance travelled at Carl's moveSpeed (exact); passes through post 1 without stopping when no stop armed (targetPost becomes 2, `exposedPost()` flips 1→2); stop mid-segment → halts exactly at next post (`atPost` set, exposedPost null); stop while at a post → stays; go at a post → runs to next; go mid-segment cancels armed stop; arrival at post 4 → `home`, running ends; `markOut` freezes the runner (`out = true`, tick no-ops); `exposedPost()` correct on every segment; `reset()` → `runner() === null`.
- [ ] Implement; `npm run check` green.

---

### Task 5: MatchRoom wiring — schema, runDecision, outcome resolution

**Files:** modify `server/src/rooms/{MatchState,MatchRoom}.ts`, `server/test/MatchRoom.test.ts`.

**Schema additions (MatchState):** `FielderSchema { id, x, z, hasBall, stamina }` in `MapSchema`, `RunnerSchema { id, x, z, atPost (−1 = between posts), running, out }`, `@type('string') lastOutcome = ''` (JSON-serialised PlayOutcome; structured schema when RulesModule owns scoring in M5 — logged).

**Room changes:**
- Demo cast: batter Carl; fielding side = first 9 roster entries excluding Carl, in table order, mapped onto `FIELDING_POSITIONS` (Kian → slot 0, the bowler). Logged demo decision (draft = M7).
- Construction: `createFieldingModule(setup, { rng: createRng(seed per room), hasBounced: physics.hasBounced, applyThrow: physics.applyPitch, holdBallAt: (p) => physics.spawnBall(p) })`, `createRunningModule()`. Seed: room creation time ms — logged as the one permissible wall-clock read (it parameterises randomness, not simulation).
- On hit contact (existing `handleSwing` success path): `running.startRun(DEMO_BATTER)`.
- Tick order (after `physics.step`): `fielding.tick` → `running.tick` → run-out check (`physics.isBallAtPost(n−1)` OR holder within POST_SENSOR_RADIUS of post n, where n = `running.exposedPost()`) → outcome resolution. First outcome ends the play: set `lastOutcome`, broadcast `playOutcome` message (§7 subset), `ballLive = false`, respawn ball, `fielding.reset()`, `running.reset()`. Outcomes: fielding `caught` → caught; run-out → runOut; runner `home` → rounder; ball at rest/timeout with live runner → safe at `atPost ?? last post reached` (mid-segment at play end = safe at previous post, M4 simplification — logged; M5 rules refine).
- `runDecision` handler: reject (demoLog) unless ball live, runner active and not out, payload has boolean `go`. Same `asRecord` guard pattern as pitch/swing.
- Copy fielder/runner views into schema each tick.

**Steps:**
- [ ] Failing integration tests (@colyseus/testing, mirroring M3 patterns): pitch+swing contact → runner schema appears running towards post 1; `runDecision {go:false}` → runner halts at post 1 and play eventually ends `safe` at 1 (sim until outcome); forced run-out: monkey-patch/seed so ball is delivered to exposed post while runner mid-segment → `runOut` with correct post + ballLive false + playOutcome message received; forced catch (rng stub via room test hook or seed chosen so first roll succeeds pre-bounce) → `caught`; `runDecision` with no live ball, or non-boolean payload, or payload-less message → rejected, state unchanged (regression-class: payload-less must not crash); fielder schema mirrors module (9 fielders at FIELDING_POSITIONS after reset).
- [ ] Implement; `npm run check` green. Existing M3 room tests stay green (demo loop preserved when nobody swings).

---

### Task 6: Client — render fielders/runner, run keys, outcome display

**Files:** modify `client/src/{RenderModule,InputModule,main}.ts`.

- RenderModule: capsule meshes per fielder from the map schema (holder tinted), one runner mesh; same lerp-to-authoritative approach as the ball; add/remove on schema add/remove.
- InputModule: **R** → `runDecision {go:true}`, **T** → `runDecision {go:false}`.
- main.ts: status line shows `lastOutcome` + listens for `playOutcome`.
- No styled UI (unslop-ui governs real UI milestones — unchanged from M3 note).

**Steps:**
- [ ] Implement (render-only; no client tests exist yet — parity with M1/M3 client scope, verified in acceptance run).
- [ ] `npm run check` green (client typecheck + lint).

---

### Task 7: Full verification, acceptance, project log

- [ ] `npm run check` — all workspaces green, record counts.
- [ ] Acceptance (§9.4) over real Colyseus (scripted WS client, as M3): (a) hit → nearest fielder chases, gathers post-bounce, throws to the exposed post → `runOut`; (b) same seed but runner stopped at post 1 via `runDecision` → `safe`; (c) seed/stat setup yielding a pre-bounce catch → `caught`. Log each outcome message received.
- [ ] Browser demo: `npm run dev`, verify fielders visible, R/T drive the runner, outcome shown.
- [ ] TUNING.md: note first-guess values (APPROACH_W, APPROACH_REF_SPEED, THROW_RELEASE_DELAY_S, stamina costs, CATCH_HEIGHT_MAX, FIELDING_POSITIONS).
- [ ] Update CLAUDE.md §6: Current State, Decisions (user's four M4 answers + demo cast + safe-at-previous-post simplification + no-worktree deviation + RNG seed source), Changelog entry, Known Issues (any-client runDecision; JSON-string lastOutcome; runner stamina static within a play).
- [ ] Conventional commits per task boundary; push `claude/hello-flphi2` (retry/backoff; if the relay 403 persists, record it and stop — do not route around).

## Self-Review Notes

- pCatch ceiling: BASE 0.3 + 0.4 + 0.3 = 1.0 at 10/10 stats before penalty — a screamer at 30 m/s still gives 0.65; sane.
- Chaser using gravity-only landing prediction under a Magnus-curved ball will lag curved hits — acceptable AI imperfection, documented; NOT a determinism risk (prediction is pure).
- Run-out check consults the sensor each tick (discrete poll); the known-issues entry already accepts this for delivered-to-post balls. The holder-within-sensor branch covers a fielder carrying the ball onto the post.
- `applyPitch` reuse for throws re-anchors the accumulator via `placeBall` — with the ball as the only dynamic body this remains safe (Task 2 documents it).
