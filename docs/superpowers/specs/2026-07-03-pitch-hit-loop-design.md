# PitchModule + HitModule (Single-Player Loop) Design — Milestone 3

Source of intent: `docs/design/spec.md` §1 (module interfaces), §5 (formulas), §7 (message shapes), §9.3 (milestone). Builds on the Milestone 2 PhysicsModule. User decision incorporated: hit launch direction comes from the batter's aim vector, elevation clamped to a tunable range.

## Purpose

Convert stats + player input into ball velocities via the §5 formulas, and make the game playable single-player: pitch → timed swing → rendered ball flight. Also lands the two remaining `/shared` contracts (`formulas.ts`, `characters.ts`) that every later milestone consumes.

## Scope

**In:** `shared/src/formulas.ts` (ALL §5 formulas as pure functions — later modules consume the rest); `shared/src/characters.ts` (§3 roster, typed); `server/src/modules/PitchModule.ts`; `server/src/modules/HitModule.ts`; MatchRoom sim tick + ball schema sync + `pitch`/`swing` message handling; minimal client ball rendering + keyboard input. Exhaustive unit tests for formulas, roster, both modules.

**Out (deferred):** abilities (M9 — `curveMult`/`hitCurveMult` parameters default 1, `CANNON_ARM` window shrink hook is a parameter default); fielding/running/rules/scoring (M4/M5); full phase validation (M5/M6 — M3 uses a minimal live/idle ball guard, logged below); real aiming/timing UI (M7+/M10); client prediction (M6+).

## Shared contracts

**`formulas.ts`** — pure, no side effects, every constant from `CONST.GAME`. Exact §5 implementations:
`s01(stat) = stat / 10`; `moveSpeed(speed, fatigueMult)`; `catchRadius(reach)`; `pitchSpeed(pitch)`; `pitchSpin(spin, curveMult)`; `timingWindow(reflex) = BASE_TIMING_WINDOW * (0.6 + 0.4·s01(reflex))`; `timingFactor(timingError, window) = clamp(1 − |err|/window, 0, 1)`; `exitVelocity(power, timingFactor)`; `hitSpin(spin, hitCurveMult)`; `pCatch(instinct, reflex, approachPenalty)`; `fatigueMult(stamina) = stamina ≥ 3 ? 1 : 0.6 + 0.4·(stamina/3)`; `pressureMult(nerve) = 0.85 + 0.15·s01(nerve)`. Stats are integers 1–10; functions do not validate range (roster is the only source, validated there) but must be total for any finite number.

**`characters.ts`** — the §3 table verbatim as `CHARACTERS: readonly Character[]`; `Character { id, name, stats: StatBlock, ability: AbilityId }`; `StatBlock { speed, reach, power, pitch, spin, stamina, reflex, instinct, nerve }`; `AbilityId` = union of the 11 ability names. Tests pin every row's every stat and ability, uniqueness of ids, and 1–10 range.

**types.ts additions:** `PitchInput { aim: Vec3; spinInput: number }`, `SwingInput { aim: Vec3; spinInput: number }` (the §7 messages' payloads; `swing.timing` is carried at the message layer, see Timing below).

## PitchModule

`resolvePitch(stats: StatBlock, input: PitchInput): PitchParams` — pure function module.
- Speed: `pitchSpeed(stats.pitch)`; velocity = normalised `input.aim` × speed. Aim semantics: direction from the bowling square towards the batter; if `aim` is zero/non-finite the pitch is aimed at the batting square at release height (default straight ball). The aim's y-component is clamped so pitches can't be lobbed above `PITCH_ELEVATION_MAX_DEG`.
- Spin: `spinInput` is a scalar in [−1, 1] (clamped); angular velocity = `(0, pitchSpin(stats.spin, 1) × spinInput, 0)` — pure sidespin about the vertical axis, which the Magnus force turns into lateral curve. `curveMult` stays 1 until `CURVEBALL_MASTER` (M9).
- Returns `PitchParams` with `origin` = bowling square at `BALL_RELEASE_HEIGHT`.

## HitModule

`resolveSwing(stats: StatBlock, input: SwingInput, timingError: number): SwingResult` where `SwingResult = { contact: true; params: HitParams; timingFactor: number } | { contact: false }` — pure function module.
- Window: `timingWindow(stats.reflex)` (the `CANNON_ARM` ×0.85 batter-window shrink is an optional `windowMult` parameter defaulting to 1, wired in M9).
- `timingFactor(timingError, window)`; if it is 0 (i.e. |error| ≥ window) → `{ contact: false }` — a miss; the ball flies on.
- Exit speed: `exitVelocity(stats.power, timingFactor)`.
- Direction (user decision): normalised `input.aim`, with elevation clamped to `[HIT_ELEVATION_MIN_DEG, HIT_ELEVATION_MAX_DEG]` (new tunables −10° / 60°). Zero/non-finite aim defaults to a flat drive towards mid-field (between posts 1 and 2).
- Spin: `(0, hitSpin(stats.spin, 1) × clampedSpinInput, 0)`.

## Timing (decision, logged)

The server is authoritative for timing. Each pitch records the sim-time at release; the ideal contact time is when the ball's centre crosses the batting-square vertical plane (z = `BATTING_SQUARE.z`, i.e. z ≤ 0 while travelling towards the batter), computed during stepping. `timingError = simTimeAtSwing − idealContactTime` (positive = late; if the ball hasn't crossed yet, negative = early, derived from projected crossing using current velocity). The §7 `swing(timing, …)` client field is accepted but ignored in M3 (reserved for client-side timestamping when networking lands in M6) — logged as a decision.

## MatchRoom wiring (single-player demo)

- On room creation: build the PhysicsModule; fixed demo cast — pitcher **Kian**, batter **Carl** (logged decision; draft arrives M7).
- Sim tick: `setSimulationInterval` at 60 Hz driving `physics.step(dt)` where dt is the elapsed interval **clamped to `SIM_MAX_CATCHUP = 0.25 s`** (the §6.4 carry-over item — closes the catch-up-burst hole).
- Schema: `BallSchema { x y z vx vy vz wx wy wz }` (numbers) added to `MatchState`, copied from `getBallState()` each tick; plus `ballLive: boolean`.
- Messages (minimal validation — full phase machine is M5): `pitch` accepted only when the ball is not live (else rejected + logged); `swing` accepted only while a pitch is in flight and not already swung at; malformed payloads (non-finite numbers) rejected. Rejection = ignore + a `demoLog` string on state for visibility.
- Play ends for the demo when the ball has been live for 6 s or comes to rest (speed < 0.1 m/s for 1 s); ball respawns idle at the bowling square.

## Client (minimal, render-only)

- `RenderModule` beginnings: a ball mesh driven from schema patches (lerp towards latest authoritative position — no client physics yet).
- `NetModule` beginnings: Colyseus.js client joining the `match` room on load.
- Input (`InputModule` beginnings): **P** = pitch (spin cycles −1/0/+1 with **A**/**S**/**D** before pitching), **Space** = swing. Demo aim vectors are fixed constants (pitch: at the batting square; hit: flat drive to mid-field, 25° elevation) — real aiming UI is a later milestone. On-screen feedback is a bare `<pre>` status line fed from state (no styled UI in M3; `unslop-ui` governs the real UI milestones, logged).

## New tunables (spec silent; to §6.2)

`GAME.HIT_ELEVATION_MIN_DEG = -10`, `GAME.HIT_ELEVATION_MAX_DEG = 60` (user-approved aim-based launch), `GAME.PITCH_ELEVATION_MAX_DEG = 20`, `PHYSICS.SIM_MAX_CATCHUP = 0.25` (s), `GAME.PLAY_TIMEOUT_S = 6`, `GAME.BALL_REST_SPEED = 0.1` (m/s), `GAME.BALL_REST_TIME_S = 1`.

## Error handling

- Formula inputs are trusted (roster-sourced); modules clamp user-controlled inputs (`spinInput`, aim elevation) and replace degenerate aim vectors with defaults rather than throwing (player input must never crash the room).
- Message handlers validate: correct sender phase-analogue (ball idle/live), finite numbers, else reject.

## Testing

- **formulas.test.ts (exhaustive):** each formula pinned at stat 1, 5/6 (midpoint), 10 against hand-computed exact values; clamp edges (timingFactor at 0, at window, beyond; pCatch clamped to [0,1]; fatigueMult at stamina 0, 2.999, 3, 10); purity (same input → same output, no mutation).
- **characters.test.ts:** every §3 row pinned exactly (all 9 stats + ability per character); 11 unique ids; all stats within 1–10.
- **PitchModule.test.ts:** speed magnitude = `pitchSpeed(stats.pitch)` for Kian (pitch 8 → 12 + 18×0.8 = 26.4 m/s); spin magnitude = `pitchSpin` scaled by spinInput incl. clamp at ±1; zero aim → defaults towards batting square; elevation clamp.
- **HitModule.test.ts:** perfect timing (error 0) → exit = `exitVelocity(power, 1)` for Carl (power 8 → 10 + 30×0.8 = 34 m/s); error = window/2 → timingFactor 0.5 → half exit speed; error ≥ window → no contact; window scales with reflex per formula; elevation clamped both ends; spin sign follows spinInput.
- **MatchRoom.test.ts additions:** pitch message while idle → ball becomes live with expected velocity; second pitch while live → rejected (state unchanged); swing with no live ball → rejected; full loop: pitch, step until plane-crossing, swing at near-ideal time → ball velocity changes to a hit trajectory (server-side integration test via @colyseus/testing).
- **Manual acceptance (§9.3):** `npm run dev`, browser: press P, watch pitch curve in, press Space in the window, watch the ball fly — verified by controller with headless-Edge screenshots or real browser.

## Verification

`npm run check` green; the MatchRoom integration test proves pitch → timed swing → changed flight server-side; manual run demonstrates the loop visually.
