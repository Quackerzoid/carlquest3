# Auto-Play Manager Redesign + Presentation Overhaul — Design

Date: 2026-07-05. Status: USER-APPROVED (this session).
This is a USER-DIRECTED GAME-LOOP REDESIGN superseding parts of spec §7: players no longer send
`pitch`/`swing`/`runDecision`. The game is management — positioning, substitutions, bowler/batter
choice — and plays resolve automatically as visible dice-roll beats. User decisions: fully
automatic running; visible roll moments; full angular esports UI restyle (Marvel-Rivals-INSPIRED,
distinct identity, parchment retires); clamped orbit camera; pitcher throw + batter hit
animations; **counter-clockwise running (mirror the field orientation)**; a proper skybox.
Beat pacing ≈ 1 s (user accepted the proposed pacing).

## 1. Field orientation fix (shared — the one sanctioned gameplay-adjacent change)

From the match camera (screen-right = −x), runners visibly circle CLOCKWISE today. Fix by
mirroring x in `shared/src/constants.ts`: negate the x of every `POSTS` entry and every
`FIELDING_POSITIONS` entry (BOWLING/BATTING squares are on x=0; LEGAL_ZONE is x-symmetric).
Behaviour-identical by reflection symmetry; runners then appear to run counter-clockwise
(first post to the batter's right), matching real rounders. Tests that read positions from CONST
adapt automatically; any test with a hardcoded mirrored coordinate is re-derived (documented).
Logged in §6.2 as user-directed.

## 2. Auto-play server

- **New pure `AutoPlayModule`** (`server/src/modules/AutoPlayModule.ts`): given the injected rng
  and the play context, it produces the beat decisions:
  - `pitchDecision(pitcher)` → `{ aim, spinInput, roll }` — spin magnitude stat-weighted
    (high spin stat → more likely full spin), aim at the batting square with a small scatter roll.
  - `swingDecision(batter, ctx)` → `{ aim, timingError, roll }` — timing error SAMPLED from the
    rng, scaled so the probability of connecting equals what the real window maths implies (the
    existing `timingWindow` × CANNON mult × `spinReadPenalty` chain, SWITCH immune; CLUTCH/
    POWER_BASE unchanged downstream). Aim = stat-weighted zone roll over the field (power pulls
    deep zones; mirrored coordinates from CONST).
  - `runDecision(runner, situation)` → `{ go, roll }` — nerve/instinct roll against the live
    situation (ball held? ball distance to the threatened post?), evaluated at contact and at
    each post arrival (the room already knows arrivals via exposures/atPost transitions).
- **MatchRoom drives beats on sim time** (pause-safe like everything else): PLAY entry → pitch
  beat at +1.0 s → auto-swing when the ball reaches the plane (same timing-error application
  path as the old handleSwing — resolveSwing is unchanged) → run beats as they arise. Constants
  for beat delays in `GAME` (`AUTOPLAY_PITCH_DELAY_S: 1.0`, `AUTOPLAY_BEAT_MIN_GAP_S: 0.6`).
- **`roll` broadcast** per contest: `{ contest: 'pitch' | 'swing' | 'run' | 'catch', actorId,
  detail: string, roll: number, threshold: number, success: boolean }`. Catch attempts reuse the
  EXISTING FieldingModule rolls — the module gains an optional `onRoll` callback dep so the room
  can broadcast them (no behaviour change; IMMOVABLE emits a guaranteed-success roll event
  without an rng draw).
- **Player messages removed:** `pitch`/`swing`/`runDecision` from clients are rejected with the
  exact prose `'plays resolve automatically'` (message handlers stay registered as tombstones).
  All positioning/subs/setPitcher/setBatter/confirm/ready/rematch flows are UNCHANGED.
- All rolls through the room's injected seeded rng → deterministic tests. Physics, formulas,
  abilities, scoring, rules: untouched.

## 3. Client play presentation

- **Batter rendered:** the current batter (from `currentBatterId`) stands at the batting square
  in a batting stance holding a simple bat prop (new accessory in CharacterModels), batting-side
  kit; hands off to the runner rendering at contact (no double render: batter figure hides when
  a runner with the same id exists).
- **Pitcher throw animation:** on the pitch roll broadcast, the bowler's model plays a wind-up →
  release arm animation timed so release coincides with `ballLive` (the ball already spawns at
  the pitching spot = his position).
- **Batter hit animation:** on the swing roll broadcast, the batter plays a bat swing (connect
  and miss both swing; a miss just follows through).
- Both animations are timed poses on the existing pivot rig (same sine/lerp machinery — no
  animation system).

## 4. Camera

Clamped orbit: drag to orbit around the pitch centre, wheel to zoom (min/max radius), polar
clamped (≈10°–80° elevation), never past the stands; `Home` key AND double-click reset to the
classic view. Drag vs click disambiguated by a movement threshold so click-to-reposition works
from any angle. Implemented hand-rolled or via three's OrbitControls with limits — implementer's
choice, but the reposition raycast must use the live camera (it already does).

## 5. UI restyle — angular esports identity (parchment retires)

Design language (unslop-ui pass mandatory; inspired by hero-shooter HUDs, NOT a copy): dark
glassy panels with hard diagonal cuts (clip-path skews ≈ 4–6°), big condensed uppercase display
type (system condensed stack), team accent slashes (kit navy/maroon), high-contrast readouts.
Surfaces: lobby, draft sheet, positioning panel, scorer's board → match HUD, event feed, key
legend (now only Enter/N + mouse hints), result overlay, and the NEW **roll-flash banner** — a
brief centre-top flash per `roll` broadcast ("KIAN PITCHES — SPIN 8 v READ 4 — BEATEN") stacking
gracefully when beats come fast, echoed as a feed line. The dice moments are the star.

## 6. Skybox

Replace the gradient dome with a proper procedural skybox: 6-face canvas cubemap (or equirect
dome upgrade) with sun, graded horizon, and scattered clouds — warm late-afternoon to match the
stadium lighting. Procedural only (no asset files); software-rasterizer safe.

## 7. Verification

- AutoPlayModule unit tests (seeded rng → exact decisions; connect-probability sanity vs window
  maths; ability hooks: CANNON shrinks effective connect rate, SWITCH ignores spin-read).
- Room integration: a readied play resolves to a `playOutcome` with ZERO client play messages;
  old messages rejected with the exact prose; `roll` broadcasts observed in order
  (pitch → swing → …); pause freezes beats; **large test migration**: every room test that drove
  plays via pitch/swing helpers re-derives to "seed rng → ready → await resolution" (documented
  honestly; gates never weakened). Orientation mirror: tests reading CONST adapt; hardcoded
  mirrored coordinates re-derived.
- Browser acceptance: watch a full auto-play with roll banners (screenshots), batter visible at
  the square with bat, pitcher wind-up frame captured, counter-clockwise run direction asserted
  from schema x-sign at first post arrival, orbit camera moved + reset (screenshots), skybox and
  restyled UI screenshotted; reposition from an orbited camera still works.

## 8. Out of scope

- Any change to formulas/abilities/scoring; spectator/replay; audio; batting-side aggression
  sliders or tactical inputs during PLAY (pure auto this iteration); ranked mode.
