# FieldingModule + RunningModule Design — Milestone 4

Source of intent: `docs/design/spec.md` §1 (module interfaces), §3 (abilities noted, wired M9), §5 (formulas: moveSpeed, catchRadius, pCatch, fatigue), §6 (Whale WALL collider note), §7 (message shapes), §8 (outs), §9.4 (milestone). Builds on the M2 PhysicsModule and M3 pitch/hit loop.

User decisions incorporated (asked 2026-07-03, this session):
1. **Runner control = player stop/go** — a new client→server message beyond spec §7, user-approved deviation: `runDecision { go: boolean }`.
2. **Catch roll = one roll per radius entry** — a fielder rolls `pCatch` once when the ball first enters their catch radius; no re-roll until the ball leaves and re-enters.
3. **Throw speed = `pitchSpeed(pitch)`** — no new formula; a fielder's throw travels at their §5 pitch speed. (`CANNON_ARM`'s +3 effective Pitch will therefore boost throws when abilities land in M9.)
4. **Fielder AI = two-fielder pursuit** — the fielder nearest the ball's predicted gather point chases; the second-nearest moves to cover the most threatening post (the runner's target post); everyone else holds.

## Purpose

Make a hit ball contested: fielders chase, attempt stats-driven catches, and throw to posts; the batter-runner runs the posts under player stop/go control; plays resolve to a structured outcome — caught out, run out, safe at post N, or rounder. Scoring/innings bookkeeping stays in M5 (RulesModule); M4 emits the play-level outcome.

## Scope

**In:** FieldingModule (AI movement, catch evaluation, gather/held-ball state, throw-to-post with release delay, sprint/throw stamina drain); RunningModule (post-to-post runner, stop/go, run-out + rounder detection); PhysicsModule additions (first-bounce tracking via Rapier EventQueue; static blocker capsule API); shared contracts (fielding/running types, `RunDecisionInput`, `PlayOutcome` subset, `approachPenalty` formula, seeded RNG); MatchRoom wiring (fielder/runner schema sync, `runDecision` handler, outcome resolution ending the play); minimal client render of fielders/runner + run keys.

**Out (deferred):** all ability behaviour incl. WALL activation, LONG_REACH, QUICK_DRAW, IMMOVABLE, BUTTERFINGERS, POWERHOUSE (M9 — hooks exist as parameters/defaults only); scoring, half-rounders, no-balls, innings/outs bookkeeping (M5); backstop/no-ball rules (M5); player-selectable throw targets (fielding is AI; the fielding *player's* agency is positioning, M8); positioning/substitution (M8); on-field stamina recovery and `BENCH_STAMINA_REGEN` use (M8 — bench doesn't exist yet); client prediction (M6).

## Shared contracts

**types.ts additions:**
- `RunDecisionInput { go: boolean }` — §7 deviation, user-approved. `go: true` = run (from a post, or resume); `go: false` = stop at the next post reached (a runner between posts cannot stop mid-segment; posts are the only safe places).
- `PlayOutcome` = `{ kind: 'caught'; by: string } | { kind: 'runOut'; atPost: number } | { kind: 'safe'; atPost: number } | { kind: 'rounder' }` — the M4 subset of §7 `playOutcome`; M5 adds half-rounder/no-ball.
- `FielderSetup { character: Character; position: { x: number; z: number } }` — FieldingModule construction input.

**formulas.ts addition:** `approachPenalty(ballSpeed) = APPROACH_W * clamp01(ballSpeed / APPROACH_REF_SPEED)` — the spec names the pCatch term but never defines it; definition = fast-arriving balls are harder to catch. Pure, tested, tunables in CONST.

**rng.ts (new, shared):** `createRng(seed: number): () => number` — mulberry32; deterministic, seedable, tested for reproducibility and [0,1) range. FieldingModule takes an injected rng so tests fix the seed; MatchRoom seeds per room.

**New tunables (spec silent; values are first-guess → TUNING.md notes):**
- `GAME.APPROACH_W = 0.35`, `GAME.APPROACH_REF_SPEED = 30` (m/s).
- `GAME.THROW_RELEASE_DELAY_S = 0.5` — gather→throw delay (QUICK_DRAW halves it in M9).
- `GAME.SPRINT_STAMINA_COST_PER_S = 0.15`, `GAME.THROW_STAMINA_COST = 0.5` — §5 "each sprint/throw drains stamina"; drained stamina feeds `fatigueMult` → `moveSpeed`.
- `GAME.CATCH_HEIGHT_MAX = 2.5` (m) — a ball above this is over everyone's head; no attempt (keeps radius checks 2D-sane without modelling jump).
- `FIELD.FIELDING_POSITIONS` — 9 placeholder (x, z) slots for the demo/default layout (bowler slot + 8 spread between/behind posts); replaced by real positioning in M8.

## FieldingModule

`createFieldingModule(setup: FielderSetup[], rng: () => number)` — owns fielder state; stepped by the room after `physics.step`.

Fielder state: `{ character, pos: {x,z}, stamina (live, starts at stat), hasBall, inRadius (roll latch), moving }`.

- **`tick(dt, ball: BallState, runnerTargetPost: number | null)`:**
  - **Roles (re-evaluated per tick):** chaser = fielder nearest the predicted gather point; cover = next-nearest, target = the runner's target post position (offset by 0.5 m so they don't stand inside the post); others hold. Predicted gather point: if the ball is airborne and falling-reachable, the ballistic landing point (gravity-only projection, Magnus deliberately ignored — logged approximation); if rolling, the ball's current position.
  - **Movement:** chaser/cover move toward their targets at `moveSpeed(speed, fatigueMult(stamina))`; sprinting drains `SPRINT_STAMINA_COST_PER_S * dt` (floor 0).
  - **Catch evaluation (per tick, per fielder):** if the ball is live (not held), below `CATCH_HEIGHT_MAX`, and within `catchRadius(reach)` (3D distance) — on the tick the ball *enters* the radius, roll once: `rng() < pCatch(instinct, reflex, approachPenalty(|ballVel|))`. Success → fielder `hasBall`; if `!physics.hasBounced()` the play outcome is **caught** (caught before bounce, §8); otherwise the ball is *gathered* (fielding continues). Failure → latch until exit. Ability parameters (`radiusMult`, `guaranteed`, `fumbleChance`) exist with neutral defaults; conditions land in M9.
  - **Held ball:** while a fielder `hasBall`, the room parks the physics ball at the fielder's hands (`spawnBall` at fielder pos each tick — velocity zero). After `THROW_RELEASE_DELAY_S`, the holder throws.
  - **Throw:** target = the runner's target post (run-out attempt); if no runner is between posts, no throw — the fielder walks the ball back (play will end at rest). Throw speed = `pitchSpeed(character.stats.pitch)`; drains `THROW_STAMINA_COST`. Elevation: solve the low ballistic arc for (distance, speed) with gravity; if out of range, throw at 45° (max range). Pure helper `throwVelocity(from, to, speed): Vec3 | null`, tested. Release via `physics.applyPitch({ origin: hands, velocity, angularVelocity: 0 })`.
- Exposes `getFielders()` (render/schema view), `holderId()`, and `reset(setup)` between plays.

## RunningModule

`createRunningModule()` — pure logic, no physics.

Runner path: batting square → post 1 → post 2 → post 3 → post 4 (FIELD coordinates), straight segments. State: `{ charId, pos, segment (0..3 = towards post segment+1), progress, running, atPost (0 = batting square, 1–4), out }`.

- **`startRun(character)`** — called on bat contact; runner auto-starts towards post 1 (decision: hitting commits you to run, matching rounders; the player may send stop before post 1).
- **`setDecision(go: boolean)`** — go: from a post, start towards the next; mid-segment, clear any pending stop. stop: mid-segment, arm stop-at-next-post; at a post, stay.
- **`tick(dt)`** — advance `moveSpeed(speed, fatigueMult(stamina))` along the segment; on arriving at a post: stop there if a stop is armed or it is post 4; otherwise continue (a `go` runner keeps running through posts). Reaching post 4 having started this play = outcome **rounder** (full circuit in one hit, §8; M5 turns it into a score).
- **Run-out check (room-driven each tick):** if the ball is inside post sensor N (`physics.isBallAtPost(N-1)`) or held by a fielder within the post sensor, while the runner is mid-segment towards post N → outcome **runOut at N**. A runner standing at a post is safe.
- **Play end while runner safe at post N** (ball at rest / timeout) → outcome **safe at N**.

## MatchRoom wiring

- Demo cast: batter/runner **Carl** (as M3); fielding side = the remaining roster's first 9 by table order (Kian bowls from slot 0). Logged demo decision; the draft replaces this in M7.
- Each tick (after `physics.step`): `fielding.tick`, `running.tick`, run-out check, held-ball parking, outcome resolution. First outcome wins and ends the play: `ballLive = false`, outcome broadcast as a `playOutcome` message (§7, subset) and mirrored into schema for late joiners; ball respawns.
- Schema additions: `FielderSchema { id, x, z, hasBall, stamina }` (MapSchema), `RunnerSchema { id, x, z, atPost, running, out }`, `lastOutcome: string` (JSON of PlayOutcome; structured schema in M5 when RulesModule owns it).
- `runDecision` handler: only from the joined client (role gating still M6/M7-level: any client, logged known issue), only while a runner is active and the ball is live; payload must be `{ go: boolean }` — else reject, log.
- The M3 `placeBall` accumulator reset stays safe: fielders/runner are **not** Rapier bodies (catching is radius+probability per §5, not collision), so no other dynamic body joins the world. The M2 §6.2 caveat is closed by design — documented in PhysicsModule.

## PhysicsModule additions

- **Bounce tracking:** collision `EventQueue`; ground-contact events set a `bounced` flag, cleared by `applyPitch`/`applyHit`/`spawnBall`. `hasBounced(): boolean`. (Caught-before-bounce, §8, must be event-accurate — a fast skimming contact between polls would corrupt outcomes; the known-issue list already prescribes EventQueue over polling.)
- **Blocker API:** `setBlocker(id, pos, halfHeight, radius)` / `clearBlocker(id)` — static capsule colliders (spec §6, The Whale). Capability lands + is tested now; nothing activates it until WALL wiring in M9. Logged.

## Client (minimal)

- Fielder meshes (capsules, fielding-team colour; holder highlighted) and runner mesh driven from schema patches, same lerp approach as the ball.
- Keys: **R** = run (go), **T** = stop. Status line shows the play outcome.
- Real HUD/UI remains a later milestone (`unslop-ui` governs it).

## Error handling

- `runDecision` malformed / out-of-phase → reject + demoLog, never throw.
- FieldingModule/RunningModule never receive user input directly; construction inputs are roster-sourced and trusted.
- Throw solve returns null for degenerate geometry (target ≈ origin) → no throw that tick, retry next.

## Testing

- **formulas:** `approachPenalty` pinned at 0, ref-speed, 2×ref (clamped), negative guard.
- **rng:** same seed → identical sequence; different seeds differ; outputs in [0,1).
- **PhysicsModule:** `hasBounced` false in flight, true after first ground contact, reset by respawn/pitch/hit; blocker stops a rolling ball dead ahead of it; blocker removable.
- **FieldingModule (seeded):** nearest-chaser selection; cover targets runner's target post; chaser closes on a rolling ball at `moveSpeed`; radius entry rolls exactly once (rng call-count), re-rolls after exit/re-entry; pCatch=1 catch before bounce → caught; after bounce → gathered; throw released after delay at `pitchSpeed` magnitude toward the post; sprint/throw drain stamina and slow `moveSpeed` via `fatigueMult`; ball above CATCH_HEIGHT_MAX → no attempt.
- **RunningModule:** advances at `moveSpeed(speed, 1)`; auto-run on startRun; stop arms halt at next post; go resumes; post-4 arrival = rounder; segment/atPost bookkeeping exact.
- **MatchRoom integration:** hit → runner starts; ball delivered to target post while runner mid-segment → `runOut`; runner stopped at post when ball arrives → play ends `safe`; pCatch forced to 1 with a pre-bounce catch → `caught`; `runDecision` rejected when malformed or no runner; fielder schema mirrors module state.
- **Manual acceptance (§9.4):** `npm run dev`: pitch, hit, watch the chaser run in, runner sent/stopped with R/T; observe a run-out and a safe outcome in the status line.

## Verification

`npm run check` green across workspaces; MatchRoom integration tests prove chase→gather→throw→run-out and caught-out server-side; manual demo shows the full contested play.
