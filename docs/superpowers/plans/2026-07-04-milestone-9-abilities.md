# Milestone 9 — Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire all 11 §3 abilities into PitchModule, HitModule, FieldingModule, PhysicsModule and MatchRoom, plus the user-approved spin-read penalty (SWITCH's counterpart).

**Architecture:** A pure ability registry in `/shared/abilities.ts` derives per-module modifier params from a Character; modules apply them through hooks that mostly already exist (FieldingModule's AbilityParams, HitModule's windowMult, PitchModule's curveMult, PhysicsModule's setBlocker). MatchRoom threads context (final innings, pitcher mods, live pitch spin) and drives the WALL blocker.

**Tech Stack:** TypeScript strict, Rapier physics (Magnus gating + blocker contact), Vitest.

**Design spec:** `docs/superpowers/specs/2026-07-04-m9-abilities-design.md` — read before any task.

## Global Constraints

- TypeScript strict; no `any`/`@ts-ignore` without justification. British English. Pure modules stay pure; all randomness through the injected rng (call-count changes are part of the contract and must be documented in tests).
- Exact constant values (design §1, one `ABILITY` block in `shared/src/constants.ts`): `CLUTCH_POWER_BONUS: 3`, `CURVE_SPIN_MULT: 1.6`, `CURVE_ONSET_FRACTION: 0.6`, `LONG_REACH_RADIUS_MULT: 1.4`, `STATIONARY_SPEED_EPS: 0.1`, `QUICK_DRAW_DELAY_MULT: 0.5`, `CANNON_PITCH_BONUS: 3`, `CANNON_TIMING_WINDOW_MULT: 0.85`, `POWER_BASE_BONUS: 2`, `POWER_BASE_MAX_ERROR: 0.1`, `BUTTERFINGERS_FUMBLE_P: 0.35`, `POWERHOUSE_RADIUS_BONUS_M: 0.5`, `POWERHOUSE_FATIGUE_FLOOR: 2`, `SPIN_READ_W: 0.25`.
- Effective stats UNCAPPED (user decision). Determinism preserved (physics twin-equality test must stay green/extended).
- Verification per task: `npm run check` green. Never rebuild fielding during PLAY (M8 contract) — WALL is a blocker update, not a rebuild.
- Concurrent implementers do NOT commit; controller serialises. Worktree via superpowers:using-git-worktrees.
- Deterministic draft facts for room tests (helpers exist): A = carl,laurie,joel,jonty,joe / B = kian,josh,darcy,robbie,ricy; whale undrafted by the table-order helper — WALL room tests must draft the whale explicitly (pick him early for side B).

## File Structure

- Create: `shared/src/abilities.ts`, `shared/test/abilities.test.ts`
- Modify: `shared/src/constants.ts` (+ABILITY block) + test; `shared/src/formulas.ts` (+spinReadPenalty) + test; `shared/src/types.ts` (`PitchParams.curveOnsetS?`); `shared/src/index.ts` (export abilities)
- Modify: `server/src/modules/PitchModule.ts` + test; `server/src/modules/PhysicsModule.ts` + test; `server/src/modules/HitModule.ts` + test; `server/src/modules/FieldingModule.ts` + test
- Modify: `server/src/rooms/MatchRoom.ts` + `server/test/MatchRoom.test.ts`
- Create: `docs/superpowers/acceptance/m9-*` (Task 6)

**Sequencing:** Task 1 (shared foundation) → Tasks 2 (pitch+physics) ∥ 3 (hit) ∥ 4 (fielding) — disjoint server files → Task 5 (MatchRoom wiring + WALL) → Task 6 (acceptance + docs).

---

### Task 1: Shared foundation — constants, registry, spin-read formula, PitchParams field

**Files:**
- Modify: `shared/src/constants.ts`, `shared/test/constants.test.ts`, `shared/src/formulas.ts`, `shared/test/formulas.test.ts`, `shared/src/types.ts`, `shared/src/index.ts`
- Create: `shared/src/abilities.ts`, `shared/test/abilities.test.ts`

**Interfaces (Tasks 2–5 depend on these exact names):**

```typescript
// shared/src/abilities.ts
export interface FieldingAbilityParams {
  radiusMult: number;            // static multiplier (neutral 1)
  stationaryRadiusMult: number;  // applied ONLY while the fielder's speed < ABILITY.STATIONARY_SPEED_EPS (LONG_REACH 1.4; neutral 1)
  radiusBonusM: number;          // additive metres (POWERHOUSE 0.5; neutral 0)
  guaranteed: boolean;           // IMMOVABLE: skip the pCatch roll
  fumbleChance: number;          // BUTTERFINGERS 0.35; neutral 0 — NO fumble roll is made when 0
  releaseDelayMult: number;      // QUICK_DRAW 0.5; neutral 1
  fatigueFloor: number;          // POWERHOUSE 2: fatigueMult forced to 1 while stamina >= floor; neutral Infinity (normal fatigue always)
}
export interface PitchAbilityMods {
  pitchStatBonus: number;        // CANNON_ARM 3; neutral 0 (uncapped)
  spinCurveMult: number;         // CURVEBALL_MASTER 1.6; neutral 1
  curveOnsetFraction: number;    // CURVEBALL_MASTER 0.6; neutral 0 (curve immediately)
  batterTimingWindowMult: number;// CANNON_ARM 0.85; neutral 1
}
export interface HitAbilityMods {
  clutchPowerBonus: number;      // CLUTCH_SWING 3 (final innings only — CALLER gates); neutral 0
  powerBaseBonus: number;        // POWER_BASE 2; neutral 0
  powerBaseMaxError: number;     // POWER_BASE 0.1 s; neutral 0
  spinReadImmune: boolean;       // SWITCH
}
export function fieldingAbilityParams(c: Character): FieldingAbilityParams;
export function pitchAbilityMods(c: Character): PitchAbilityMods;
export function hitAbilityMods(c: Character): HitAbilityMods;
// formulas.ts
export function spinReadPenalty(spinStat: number, spinInput: number): number; // 1 − SPIN_READ_W·s01(spinStat)·|spinInput|, clamped ≥ 0
// types.ts — PitchParams gains:
//   /** Seconds after release before Magnus curve activates (CURVEBALL_MASTER); 0/absent = immediate. */
//   curveOnsetS?: number;
```

- [ ] **Step 1: Failing tests.** `shared/test/abilities.test.ts` — for each of the 11 roster characters assert the exact mapping (kian → pitch mods {0, 1.6, 0.6, 1}; joel → {3, 1, 0, 0.85}; carl → hit mods {3, 0, 0, false}; robbie → {0, 2, 0.1, false}; darcy → spinReadImmune true; laurie → fielding stationaryRadiusMult 1.4; josh → releaseDelayMult 0.5; jonty → guaranteed true; joe → fumbleChance 0.35; ricy → radiusBonusM 0.5 + fatigueFloor 2; whale → ALL NEUTRAL from these three functions (WALL is physics/room, not registry)); neutral character (e.g. carl's fielding params) gets the full neutral object. `formulas.test.ts`: `spinReadPenalty(0, 1) === 1`... careful: s01(0)=0 → 1 ✓; `spinReadPenalty(10, 1) === 1 - 0.25`; `spinReadPenalty(10, 0) === 1`; `spinReadPenalty(10, -1) === 0.75` (|input|); result never below 0. `constants.test.ts`: pin every ABILITY value listed in Global Constraints.
- [ ] **Step 2: RED** — `/shared`: `npx vitest run`.
- [ ] **Step 3: Implement.** Constants block; `spinReadPenalty` using existing `s01` + `Math.max(0, …)`; `abilities.ts` as three pure lookup functions (switch on `c.ability`, return neutral defaults otherwise — spread a `NEUTRAL_*` const per shape); `PitchParams.curveOnsetS?: number` with the doc comment; export `* from './abilities'` in index.ts.
- [ ] **Step 4: GREEN** shared; `npx tsc --noEmit -p server/tsconfig.json` still clean (optional field is additive). Controller commits: `feat(shared): ability registry, ABILITY constants, spin-read penalty`.

---

### Task 2: PitchModule mods + PhysicsModule curve onset

**Files:**
- Modify: `server/src/modules/PitchModule.ts`, `server/test/PitchModule.test.ts`, `server/src/modules/PhysicsModule.ts`, `server/test/PhysicsModule.test.ts`

**Interfaces:**
- Consumes: Task 1's `PitchAbilityMods`, `ABILITY` constants, `PitchParams.curveOnsetS`.
- Produces: `resolvePitch(stats: StatBlock, input: PitchInput, mods?: PitchAbilityMods): PitchParams` (absent mods = neutral — all existing call sites unchanged); PhysicsModule: Magnus suppressed until `curveOnsetS` sim-seconds after the corresponding `applyPitch`; `applyHit` always resets the gate to 0 (hits curve immediately, current behaviour).

- [ ] **Step 1: Failing PitchModule tests:** with kian's stats + CURVEBALL mods: `angularVelocity.y` is ×1.6 the neutral value for the same input, and `curveOnsetS` > 0 and ≈ `(distance from BOWLING_SQUARE to the batting plane along the aim) / pitchSpeed(stats.pitch) × 0.6` (compute the expected value in the test from CONST + formulas — no magic numbers); with joel's CANNON mods: `|velocity|` equals `pitchSpeed(stats.pitch + 3)` (uncapped); neutral/no-mods: params identical to today's output and `curveOnsetS` 0 or undefined.
- [ ] **Step 2: Failing PhysicsModule tests:** (extend the existing Magnus/determinism suite's style) a spun pitch with `curveOnsetS` = half its flight: |lateral deviation at onset time| < 1e-3 m, deviation at the plane > 0.05 m; the SAME pitch with onset 0 deviates from the first substeps; determinism twin-test extended to a curve-onset pitch (exact float equality); a subsequent `applyHit` curves immediately (no leaked gate).
- [ ] **Step 3: RED** both files.
- [ ] **Step 4: Implement.** PitchModule: `mods` default `{ pitchStatBonus: 0, spinCurveMult: 1, curveOnsetFraction: 0, batterTimingWindowMult: 1 }`; effective pitch stat = `stats.pitch + mods.pitchStatBonus`; `pitchSpin(stats.spin, mods.spinCurveMult)`; flight estimate: horizontal distance from origin to `FIELD.BATTING_SQUARE`'s z-plane along the normalised aim ÷ speed (guard: aim moving away or zero horizontal → onset 0); `curveOnsetS = estimate × mods.curveOnsetFraction`. PhysicsModule: store `curveOnsetRemaining` (seconds) set from `params.curveOnsetS ?? 0` in `applyPitch`, set to 0 in `applyHit` and on spawn/place; each substep, if `curveOnsetRemaining > 0` decrement by the substep dt and SKIP the Magnus force application that substep (decrement before/after consistently — pick one, document; partial-substep precision is irrelevant at 1/60 s granularity but the decrement must be deterministic).
- [ ] **Step 5: GREEN** both files + whole server suite (`npx vitest run` from /server — fielding throws use applyPitch with no onset; nothing should move). Controller commits: `feat(server): pitch ability mods + Magnus curve-onset gating`.

---

### Task 3: HitModule swing context

**Files:**
- Modify: `server/src/modules/HitModule.ts`, `server/test/HitModule.test.ts`

**Interfaces:**
- Consumes: Task 1's `HitAbilityMods`, `spinReadPenalty`, ABILITY constants.
- Produces (Task 5 calls this): `resolveSwing(stats: StatBlock, input: SwingInput, timingError: number, ctx?: SwingContext): SwingResult` with

```typescript
export interface SwingContext {
  mods: HitAbilityMods;           // the batter's (neutral default)
  isFinalInnings: boolean;        // rules.isFinalInnings() — gates CLUTCH
  timingWindowMult: number;       // pitcher CANNON_ARM ×0.85 (neutral 1)
  pitcherSpinStat: number;        // spin-read penalty inputs (neutral 0 → penalty 1)
  pitchSpinInput: number;
  pressure: boolean;              // absorbs the old positional param
}
export const NEUTRAL_SWING_CONTEXT: SwingContext; // exported for tests/callers
```

  This REPLACES the old `windowMult`/`pressure` positional params — update the existing call sites in HitModule tests; MatchRoom's call site is Task 5's (leave a compiling default: `ctx` optional with `NEUTRAL_SWING_CONTEXT`, so MatchRoom compiles unchanged until Task 5 threads the real context — verify the old MatchRoom call `resolveSwing(stats, input, error, 1, pressure)` DOES break the build (two positional args) and therefore make the minimal Task-3-scoped edit to MatchRoom's one call site: `resolveSwing(batter.stats, {...}, error, { ...NEUTRAL_SWING_CONTEXT, pressure })` — behaviour identical, Task 5 replaces it properly. Document this one-line room edit in the report.)

- [ ] **Step 1: Failing tests:** window shrink: effective window = `timingWindow(reflex) × timingWindowMult × spinReadPenalty(pitcherSpinStat, pitchSpinInput)` — assert a timing error that connects at neutral misses with CANNON ×0.85 (choose an error between the two windows; compute both in the test from formulas); SWITCH (`spinReadImmune: true`) with max spin facts connects where a non-immune batter misses; CLUTCH: exit speed = `exitVelocity(power + 3, timing)` ONLY when `isFinalInnings` (false → base); POWER_BASE: +2 only when `|timingError| < 0.1` (test 0.05 → bonus, 0.15 → none); combinations (CLUTCH batter never also POWER_BASE — single ability per character, but test the maths composes by constructing a synthetic mods object with both — document it as synthetic).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** per the interface (effective power = `stats.power + (ctx.isFinalInnings ? mods.clutchPowerBonus : 0) + (Math.abs(timingError) < mods.powerBaseMaxError ? mods.powerBaseBonus : 0)`; window mult chain with immunity skipping only the spinReadPenalty factor).
- [ ] **Step 4: GREEN** HitModule file + server typecheck (the one-line MatchRoom edit). Controller commits: `feat(server): ability-aware swing context (clutch, power-base, cannon window, spin-read)`.

---

### Task 4: FieldingModule abilities

**Files:**
- Modify: `server/src/modules/FieldingModule.ts`, `server/test/FieldingModule.test.ts`

**Interfaces:**
- Consumes: Task 1's `fieldingAbilityParams` + `FieldingAbilityParams` (REPLACES the module's private `AbilityParams`/`NEUTRAL` — delete those, import the shared shape).
- Produces: behaviourally — per-fielder params derived at setup from `setup.character`; effective catch radius = `(catchRadius(reach) × radiusMult × (speed < ABILITY.STATIONARY_SPEED_EPS ? stationaryRadiusMult : 1)) + radiusBonusM`; IMMOVABLE skips the pCatch roll entirely (NO rng call for it); BUTTERFINGERS: after a WON catch/gather roll (or a guaranteed catch — spec: "on every catch attempt in radius… regardless of stats"), one EXTRA rng call `rng() < fumbleChance` (skipped entirely when fumbleChance is 0 — neutral call counts unchanged); a fumble: ball parked at the fielder's feet on the ground (`holdBallAt({x: fielder.x, y: BALL_RADIUS, z: fielder.z})`) but NOT held (no holder set), the module sets an internal `fumbledFlight = true` (cleared on `reset()`), and while `fumbledFlight` any subsequent successful catch this flight is classified `gathered`, never `caught` (a fumbled ball touched the ground by definition — closes the placeBall-resets-hasBounced trap the M4 review found); the fumbling fielder's entry latch stays set (no instant re-roll); QUICK_DRAW: release delay × 0.5; POWERHOUSE: `fatigueMult(stamina)` replaced by 1 while `stamina >= fatigueFloor`.
- rng call-count contract documented in the test file header comment (one pCatch roll per entry, EXCEPT: none for guaranteed; plus one fumble roll after any won/guaranteed attempt by a fumbleChance>0 fielder).

- [ ] **Step 1: Failing tests** (module-level, scripted rng, synthetic setups — follow the file's existing stub conventions): IMMOVABLE catches with `rng` that always misses AND with an rng spy asserting zero calls for the attempt; LONG_REACH: a ball at distance `catchRadius×1.2` is catchable only while stationary (construct: fielder already at its target so speed 0 vs. mid-chase); POWERHOUSE: radius +0.5 honoured; fatigue: at stamina 2.5 speed uses fatigueMult=1 vs a neutral fielder's `fatigueMult(2.5)` (assert position advance per tick differs); QUICK_DRAW: thrown event at ≈ half the neutral delay (existing throw tests give the idiom); BUTTERFINGERS: scripted rng [win, fumble] → no `caught` event, ball parked at feet (holdBallAt spy called with the fielder's x/z, y = BALL_RADIUS), no holder, and a LATER re-entry catch by another fielder classifies `gathered` even when `hasBounced` stub says false; scripted [win, no-fumble] → normal caught; neutral fielders make NO fumble roll (call-count assertion).
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** per above; delete the private AbilityParams/NEUTRAL, import shared; track per-fielder current speed (the module already computes each move — retain last step distance / dt).
- [ ] **Step 4: GREEN** FieldingModule + whole server suite (room tests exercise neutral paths; the drafted five are all neutral except josh QUICK_DRAW and ricy POWERHOUSE — check any room test that pins throw timing or chase distances; a legitimate change from josh's halved delay or ricy's radius must be re-derived with reasoning, not weakened). Controller commits: `feat(server): fielding abilities (immovable, butterfingers, long-reach, powerhouse, quick-draw)`.

---

### Task 5: MatchRoom threading + WALL

**Files:**
- Modify: `server/src/modules/PhysicsModule.ts` (+blocker contact stop-dead) + test, `server/src/rooms/MatchRoom.ts`, `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: everything above; the M4 `setBlocker(pos)/clearBlocker()` API (read its current shape in PhysicsModule).
- Produces: room threads — `resolvePitch(pitcher.stats, input, pitchAbilityMods(pitcher))`; room stores the delivered pitch's `spinInput` and the pitcher's mods; `resolveSwing(batter.stats, input, error, { mods: hitAbilityMods(batter), isFinalInnings: rules.isFinalInnings(), timingWindowMult: pitcherMods.batterTimingWindowMult, pitcherSpinStat: pitcher.stats.spin, pitchSpinInput: storedSpinInput, pressure })`. WALL: while `contactMade` AND the whale is on the fielding side's field, each tick BEFORE `physics.step` update `physics.setBlocker(whalePosition)`; PhysicsModule zeroes ball linear+angular velocity on ball↔blocker contact (contact events on the blocker collider, the post-sensor EventQueue idiom but for CONTACTS); blocker cleared in `endPlay`, on rematch and whenever the whale is not fielding.

- [ ] **Step 1: Failing PhysicsModule test:** place blocker capsule in a rolling ball's path → ball velocity ≈ 0 within a couple of substeps of reaching it and stays near the blocker (no bounce-off); without blocker the ball passes the point.
- [ ] **Step 2: Failing room tests:** (a) WALL: room with `fieldSlotsOverride` unnecessary — draft whale into side B explicitly (custom draft order in the test: B picks whale first — then B's default pitcher recomputes among their five; pick B's order so kian still bowls: whale is pitch 4, kian 8 → kian still default ✓); position whale via `reposition` onto the known flat-drive path (B fields innings 1); batter hits the standard flat drive; assert the ball's speed collapses near the whale's position and NO `caught` outcome fires from the stop itself (a later gather is fine); play eventually resolves. (b) CLUTCH integration: drive the match to the final innings (`isFinalInnings` — innings pair 2) and assert carl's identical-timing swing produces a higher `|ball velocity|` right after contact than the same swing in innings 1 (capture via state.ball v components next tick; compare magnitudes with margin). If driving to the final innings is too slow, construct the room with `inningsCount: 1`? — NOT an option (rules config not wire-exposed); instead play through with ALWAYS_CATCH (5 outs/innings ends fast — the M8 suite has the idiom).
- [ ] **Step 3: RED.**
- [ ] **Step 4: Implement.** PhysicsModule: blocker collider gains COLLISION_EVENTS; drain contact events in the substep loop; on ball↔blocker contact start → `setLinvel(0)/setAngvel(0)` (keep gravity — it falls). Room: store `this.lastPitchSpinInput` + `this.currentPitcherMods` at handlePitch (recompute mods there via `pitchAbilityMods(getCharacter(this.state.currentPitcherId))`); replace the Task-3 stopgap resolveSwing call with the full context; WALL tick block inside the `contactMade` branch before `physics.step` (position from `this.fielding.getFielders().find(f => f.id === 'whale')`); `physics.clearBlocker()` in endPlay/rematch and when whale absent. NOTE: the whale can only be on-field when drafted + on the fielding side — derive from the fielding module's current fielders, not the roster.
- [ ] **Step 5: GREEN** whole server suite + `npm run check`. Controller commits: `feat(server): ability context threading + WALL blocker stop-dead`.

---

### Task 6: §9.9 acceptance + docs

**Files:**
- Create: `docs/superpowers/acceptance/m9-acceptance.mjs`, `m9-acceptance.txt`
- Modify: `CLAUDE.md` §6, `TUNING.md`

- [ ] **Step 1: Scripted WS acceptance** (real `npm run dev`; assertion-accumulating, exit non-zero on failure; NO browser run — §9.9 changes no UI surface, record that): custom draft putting kian+whale+jonty+joe on side B; demonstrate live: (1) CURVEBALL late onset — pitch with full spin, sample ball x per tick, assert lateral deviation in the first 60% of flight ≪ deviation in the last 40% (log the profile); (2) WALL — reposition whale onto the drive path, hit, assert ball speed collapse at his position; (3) IMMOVABLE — jonty positioned at the drive path catches (seedless assertion: with jonty there, kind === 'caught' by jonty across a play where pCatch would be fallible — acceptable because guaranteed skips the roll); (4) BUTTERFINGERS — a room with a numeric seed found by BOUNDED search (≤ 20 seeds, documented) where joe's fumble fires: assert NO caught-out despite the ball entering joe's radius pre-bounce (the module unit tests carry determinism; this demonstrates it live); (5) CANNON/spin-read — assert darcy's swing connects on a timing where laurie's misses against kian's max-spin pitch (or assert via two rooms' outcomes; if sub-tick timing makes this flaky live, demonstrate window maths from unit tests instead and log the substitution honestly).
- [ ] **Step 2: Docs.** CLAUDE.md §6.1 overwrite (M9 status, test counts, evidence); §6.2 rows: SPIN_READ_W invented formula (USER-APPROVED); uncapped effective stats (USER-APPROVED); fumbledFlight classification guard; POWERHOUSE pitch-side fatigue immunity inert (no pitch fatigue exists); WALL stop-dead = velocity zeroing on contact. §6.3 entry; §6.4: remove the M4-era "ability hooks neutral" note; TUNING.md: SPIN_READ_W, STATIONARY_SPEED_EPS as playtest candidates.
- [ ] **Step 3:** `npm run check` green; kill servers; no lock churn; commit `docs: M9 acceptance evidence and project log`. Defect → BLOCKED.

---

## Self-Review Notes (already applied)

- Spec §1→T1, §2→T1, §3 pitch/physics→T2, hit→T3, fielding→T4, WALL+room→T5, §5→per-task tests+T6, §6 out-of-scope respected (no client task).
- Type consistency: `SwingContext`/`NEUTRAL_SWING_CONTEXT`/`PitchAbilityMods` names match across T1/T2/T3/T5; `curveOnsetS` optional (fielding throws unaffected).
- The T3 stopgap MatchRoom edit is deliberately scoped and replaced in T5 (documented in both tasks).
- BUTTERFINGERS spec wording "on every catch attempt in radius" is implemented as fumble-after-successful-attempt (a fumble of a ball you never touched is meaningless); guaranteed IMMOVABLE+fumble combination is impossible on the real roster (one ability each) — the synthetic-combination test in T3 covers maths composition only.
- WALL "active during fielding": implemented as the contactMade window, matching the fielder-AI window — the spec's phrase, one reading, logged in §6.2 at T6.
