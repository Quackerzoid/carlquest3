# Readable-Game Overhaul — Design (field ×2, pacing, ball fairness, mascots, arcade UI)

Date: 2026-07-05. Status: USER-APPROVED (this session).
User decisions: **bold arcade pop** UI (dark glass retires); **minimal mascot** characters
(body-head blob + painted canvas texture + floating sphere hands, no legs — ground-up rework,
BEFORE animations); **8–15 s readable** play pacing; **field ×2 with real speeds**.
Grounded in the committed bug investigation (scratchpad bug-investigation.md, summarised in the
session): the "acceleration" is same-tick resolution + endPlay slot-teleport (sim verified 1:1);
the "caught without hitting" is the backstop instant-catch at the contact point (every auto-hit
launches at exactly 0°; no catch arming); missed pitches waste ~7 s rolling to rest.

## Part 1 — Server/shared (Plan 1)

### A. Field ×2
- `FIELD`: POSTS, BOWLING_SQUARE (z), FIELDING_POSITIONS, LEGAL_ZONE, BATTING_SQUARE_KEEPOUT,
  GROUND_HALF_EXTENT all scale ×2 (BATTING_SQUARE stays at origin). Squares' side sizes stay
  (they are markings, not distances).
- Distance/time tunables scale coherently: `PLAY_TIMEOUT_S` ×2 (→ 12), `AUTOPLAY_RUN_DIST_REF`
  ×2 (→ 60), `POST_SENSOR_RADIUS` unchanged (contact semantics), throw/pitch/move SPEEDS
  unchanged (user decision: real speeds on a bigger field).
- Tests: coordinate-derived expectations adapt via CONST; hardcoded values re-derive under the
  scaling invariant (outcome classes may legitimately change where flight/run ratios changed —
  document each; gates never weakened).

### B. Ball flight & fairness
1. **Real loft:** `AutoPlayModule.swingDecision` samples elevation quality-weighted in
   [`AUTOPLAY_LOFT_MIN_DEG` 5, `AUTOPLAY_LOFT_MAX_DEG` 50] (better-timed contact biases flatter
   +longer, poor contact pops up — implementation formula in the plan; uniform-ish acceptable).
   The 0°-forever dead code path is eliminated.
2. **Catch arming:** no catch/gather roll for a hit flight until it has travelled
   `CATCH_ARM_DISTANCE_M` (4) from its launch point (FieldingModule tracks flight origin — the
   WALL flight-start-exemption precedent). Kills the backstop contact-tick catch.
3. **Relay throws:** when the holder throws at a threatened post, if another fielder is
   `RELAY_ADVANTAGE_M` (6) closer to that post than the holder AND closer than the post itself,
   throw to THAT fielder instead (who gathers and re-throws next beat) — real relay chains.
   One-hop logic only (no planning).
4. **Missed-pitch respawn:** a no-contact flight respawns after `MISS_RESPAWN_S` (1.5) instead
   of waiting for rest (+ the existing rest path stays as fallback).
5. **Outcome hold:** `endPlay` broadcasts the resolution immediately, then holds
   `OUTCOME_HOLD_S` (1.5, sim time) before applying the slot rebuild/phase flip (split
   resolve-now/finalise-later; pause-safe; rematch/disposal short-circuit safely).
6. Beat pacing to the 8–15 s target: `AUTOPLAY_PITCH_DELAY_S` → 1.5, `AUTOPLAY_BEAT_MIN_GAP_S`
   → 1.0 (constants only).
All new values are GAME constants; all §5 formulas and abilities untouched.

## Part 2 — Client (Plan 2)

### C. No teleporting — the walking world
- Interpolation becomes **phase-aware speed-clamped**: PLAY → fast convergence (live action);
  all other phases → movement clamped to `WALK_SPEED_M_S` (~3, client constant) so figures
  visibly walk to wherever state puts them (fielder slot returns, repositions, innings swaps).
- **Batting bench** (pure client choreography): the batting side's non-active characters sit on
  a bench beside the field (fixed client-side spots outside LEGAL_ZONE near the batting end);
  the current batter walks bench→batting square; a dismissed batter walks square/post→bench; a
  parked runner stays at their post between plays as today. Client keys all bench/batter
  movement off synced state only (queueIds, currentBatterId, playOutcome outs) — zero server
  change, no invented gameplay state.

### D. Ball presentation
- Rolls/tumbles: mesh rotation driven by velocity (roll about the horizontal axis ⊥ travel,
  scaled by speed; in-air slow tumble).
- **Highlight**: bright ring/underglow billboard at the ball's ground projection + slight
  emissive pop on the ball — never lose the ball.
- **Trail**: short fading ribbon/sprite trail while the ball is live (cheap: ~12-sample line
  strip, rasteriser-safe).
- **Held ball**: in the holder's hand sphere (mascot hands are spheres — the ball parks into
  one) + a bouncing ball **icon above the holder's head** (billboard sprite).

### E. Minimal-mascot characters (ground-up rework, replaces the limb rigs)
- One rounded **body-head blob** per character (single geometry: lathe/capsule-ish profile,
  bigger = whale, tiny = joe), **painted canvas texture per character** (face — eyes/brows/
  mouth expressing personality; kit colour/trim/number; character tells painted or minimal
  geometry: kian's cap brim, jonty's headband band, josh's glove-coloured hands, carl's
  armband stripe). **Floating sphere hands** (no arms), no legs; blob shadow.
- Movement reads through **bob/waddle + lean** (no leg animation); wind-up = hand orbits back
  then whips; bat swing = bat in hand-sphere sweeps; carry = ball in hand sphere.
- Same CharacterModel contract shape (group/ring/ball/bat/setTint/dispose/height + a reduced
  pose surface for hands/body) so RenderModule rework is contained; all M10 status semantics
  (rings, topple/tint, dyingUntil) preserved.
- Stadium adjusts to the ×2 field (Plan 1's constants drive it — stands/boards/markings/chalk
  all CONST-derived already; crowd/bowl radii re-derive; camera default + orbit clamps rescale
  to frame the bigger field).

### F. Bold arcade-pop UI + tooltips + READY button
- Identity: saturated primaries, thick outlines, chunky rounded cards, high-energy roll
  banners; light backgrounds (NOT dark); team navy/maroon kept as accents inside the pop
  palette. unslop-ui pass mandatory (own the look; no template defaults).
- Information re-grouped: one clean score strip (score/innings/outs), batter & bowler cards,
  decluttered feed, contextual action hints.
- **Hover tooltips** (title-attribute minimum, styled tooltip preferred) on: stat abbreviations,
  ability tags (full ability description from a client-side ABILITY_TEXT map), panel rows
  (reposition/sub/batter actions), READY button, camera hints.
- **READY button**: bottom-right, large, stylised; clickable AND Enter; green "READY UP" →
  blue + checkmark "READY ✓ waiting for opponent" once confirmed; shows for both
  INITIAL_POSITIONING (confirm) and PRE_PLAY (ready); hidden elsewhere; drives the same
  messages as Enter (server gates unchanged).

## Verification
- Plan 1: unit/room tests migrate under the ×2 invariant; new tests: catch arming (contact-tick
  catch impossible; a 4 m flight arms), relay throw target selection, outcome hold (fielder
  slots unchanged until OUTCOME_HOLD_S after playOutcome), missed-pitch respawn timing, loft
  sampling bounds. Full `npm run check` green ×2.
- Plan 2: typecheck/lint + browser acceptance: screenshots of the arcade UI/tooltips/READY
  states (green→blue tick), ball trail+highlight visible in a play screenshot, bench occupied
  + batter walk observed (position series from DOM/pixels, no >walk-speed jumps outside PLAY),
  mascot lineup shot, holder icon visible; a full auto-play watched with zero errors.

## Out of scope
- Any formula/ability change; ranked modes; audio; roster growth; server-side bench state;
  multi-hop relay planning; skeletal animation.
