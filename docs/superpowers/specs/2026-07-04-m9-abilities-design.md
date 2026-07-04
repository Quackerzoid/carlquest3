# M9 Design — Abilities (spec §9.9, §3)

Date: 2026-07-04. Status: USER-APPROVED (this session).
User decisions: **SWITCH gets a real mechanic** — a minimal spin-read penalty is ADDED to the
game (every batter's timing window shrinks against spin; SWITCH is immune; `SPIN_READ_W` tunable —
an invented, user-approved formula logged as such); **effective stats are UNCAPPED** (CLUTCH/
CANNON/POWER_BASE bonuses may push stats past 10 and outputs past formula MAX ranges —
spec-literal reading).

## 1. Constants — one `ABILITY` block in `shared/src/constants.ts`

All from spec §3 except the last (user-approved invention):
`CLUTCH_POWER_BONUS: 3`, `CURVE_SPIN_MULT: 1.6`, `CURVE_ONSET_FRACTION: 0.6` (Magnus in the last
40% of flight), `LONG_REACH_RADIUS_MULT: 1.4`, `STATIONARY_SPEED_EPS: 0.1` (m/s — "velocity ≈ 0"),
`QUICK_DRAW_DELAY_MULT: 0.5`, `CANNON_PITCH_BONUS: 3`, `CANNON_TIMING_WINDOW_MULT: 0.85`,
`POWER_BASE_BONUS: 2`, `POWER_BASE_MAX_ERROR: 0.1` (s), `BUTTERFINGERS_FUMBLE_P: 0.35`,
`POWERHOUSE_RADIUS_BONUS_M: 0.5`, `POWERHOUSE_FATIGUE_FLOOR: 2`, `SPIN_READ_W: 0.25`.

## 2. Shared ability registry (`shared/src/abilities.ts`, pure) + formula

- `fieldingAbilityParams(c: Character)` → `{ radiusMult, stationaryRadiusMult, radiusBonusM,
  guaranteed, fumbleChance, releaseDelayMult, fatigueFloor }` — the FieldingModule `AbilityParams`
  shape EXTENDED: `stationaryRadiusMult` (LONG_REACH ×1.4 applies only while the fielder's speed <
  STATIONARY_SPEED_EPS), `radiusBonusM` (POWERHOUSE +0.5 m additive), `fatigueFloor` (POWERHOUSE:
  fatigueMult forced to 1 until stamina < 2; everyone else floor = +Infinity sentinel meaning
  "normal fatigue").
- `pitchAbilityMods(c)` → `{ pitchStatBonus, spinCurveMult, curveOnsetFraction,
  batterTimingWindowMult }` (CANNON_ARM: +3 / ×0.85; CURVEBALL_MASTER: ×1.6 / 0.6; neutral
  otherwise: 0 / 1 / 0 / 1).
- `hitAbilityMods(c)` → `{ clutchPowerBonus, powerBaseBonus, powerBaseMaxError, spinReadImmune }`
  (CLUTCH_SWING / POWER_BASE / SWITCH; neutral: 0 / 0 / 0 / false).
- `formulas.ts` gains `spinReadPenalty(spinStat: number, spinInput: number): number` — the timing
  window multiplier `1 − SPIN_READ_W · s01(spinStat) · |spinInput|` (clamped ≥ 0). Applied to
  EVERY batter unless `spinReadImmune`.
- WALL is not in the registry (it is a physics/room concern, below); abilities with no mapping in
  a given function return the neutral values.

## 3. Module wiring

- **PitchModule.** `resolvePitch(stats, input)` becomes ability-aware via the pitcher's Character
  (signature: accept the Character or the mods — implementation plan decides; behaviour):
  CANNON_ARM adds +3 to the effective pitch stat (uncapped) before `pitchSpeed`;
  CURVEBALL_MASTER multiplies `pitchSpin`'s curveMult by 1.6 AND sets `PitchParams.curveOnsetS =
  estimatedFlightToPlane × CURVE_ONSET_FRACTION` (estimate = distance from release to the batting
  plane along the aim ÷ release speed). Neutral pitches carry `curveOnsetS: 0`.
- **PhysicsModule.** `PitchParams` gains optional `curveOnsetS` (default 0). The Magnus force is
  suppressed until `curveOnsetS` seconds of sim time have elapsed since that applyPitch/applyHit
  (per-flight timer, reset on each apply; applyHit always 0 — hits are unaffected).
- **HitModule.** `resolveSwing(...)` gains a context argument
  `{ isFinalInnings: boolean; timingWindowMult: number; pitcherSpinStat: number; pitchSpinInput:
  number }` (room supplies `rules.isFinalInnings()`, the pitcher's `batterTimingWindowMult`, and
  the delivered pitch's spin facts). Effective power = stat + CLUTCH (final innings only) +
  POWER_BASE (|timingError| < 0.1 s), uncapped. Timing window = base window × timingWindowMult ×
  spinReadPenalty (unless SWITCH). "Mirror launch direction" needs no code — aim is already free.
- **FieldingModule.** Replaces the `NEUTRAL` AbilityParams with per-fielder
  `fieldingAbilityParams(character)`. Application: IMMOVABLE skips the pCatch roll (guaranteed);
  BUTTERFINGERS rolls fumble (same injected rng, one extra call AFTER a won catch/gather roll —
  the rng call-count contract is extended and documented in tests): a fumble drops the ball dead
  at the fielder's feet on the ground (via holdBallAt at ground height then immediately released —
  ball is NOT held, play continues; it has touched ground so it can never be a caught-out; the
  entry latch prevents an instant re-roll); QUICK_DRAW halves the throw release delay; POWERHOUSE
  adds +0.5 m to catch radius and forces fatigueMult = 1 while stamina ≥ 2; LONG_REACH multiplies
  the radius ×1.4 only while that fielder's current speed < STATIONARY_SPEED_EPS.
- **WALL (MatchRoom + PhysicsModule).** While the Whale is on the fielding side's field AND the
  ball is live post-contact (the same window the fielder AI runs), the room updates the M4
  `setBlocker` capsule to the Whale's position every tick. A ball–blocker CONTACT zeroes the
  ball's linear (and angular) velocity — "stops dead", gravity then drops it. Blocker cleared at
  play end and whenever the Whale is not fielding. The Whale still fields normally (chase/catch)
  — the blocker is additional.
- **MatchRoom.** Threads context: `resolveSwing` context from rules + the current pitcher's mods +
  the live pitch's spin facts (room keeps the last-resolved PitchParams' spin input); WALL tick
  update; no other room logic changes.

## 4. Client

No client changes — DraftScreen already displays ability tags; all effects are server-side and
visible through existing outcomes/state.

## 5. Testing and acceptance (§9.9)

- `abilities.ts` unit tests: exact mapping per ability id incl. neutral defaults; `spinReadPenalty`
  formula tests (0 spin → 1; max spin/input → 1 − SPIN_READ_W; clamp).
- PitchModule: CANNON bonus feeds pitchSpeed; CURVEBALL sets spin ×1.6 and a positive plausible
  `curveOnsetS`; neutral → 0.
- PhysicsModule: with `curveOnsetS` set, lateral deviation before onset ≈ 0 (< 1e-3 m) and
  deviation after onset > 0.05 m; determinism preserved (twin-module equality test extended).
- HitModule: clutch (+3 only when final innings), power-base (+2 only under 0.1 s error), window
  shrink (CANNON ×0.85, spin-read penalty), SWITCH immunity.
- FieldingModule: guaranteed catch (IMMOVABLE, no rng call for the pCatch roll — assert call
  count), fumble path with scripted rng (won roll then fumble roll: ball not held, no out,
  drop-at-feet position, no instant re-roll), QUICK_DRAW halved delay, POWERHOUSE radius/floor,
  LONG_REACH stationary-only (moving fielder gets ×1).
- Room integration: WALL — a flat hit at the Whale's position zeroes ball velocity at contact
  (position freezes horizontally, ball drops); blocker cleared at play end. One CLUTCH_SWING
  final-innings integration (exit speed higher than the identical non-final swing).
- Acceptance: scripted WS game drafting kian (CURVEBALL), jonty (IMMOVABLE), joe (BUTTERFINGERS),
  whale (WALL) etc., demonstrating ≥4 abilities live from logs: late-curve lateral profile
  (deviation concentrated after onset), an IMMOVABLE guaranteed catch, a forced BUTTERFINGERS
  fumble (rng-scripted room or seed search — module tests carry the determinism), a Whale
  stop-dead. NO browser acceptance (no UI surface changed) — recorded as the §9.9 scope decision.

## 6. Out of scope

- Any client/UI surface; ranked-mode toggles; POWERHOUSE's pitch-side fatigue immunity is INERT
  (pitch speed is not fatigue-scaled by the §5 formulas — logged, revisit if pitch fatigue lands);
  ability tuning beyond the §3 values (TUNING.md notes only).
