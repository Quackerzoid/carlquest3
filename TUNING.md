# TUNING.md — first-guess constants awaiting playtest

Per CLAUDE.md §5, tuning suggestions live here rather than in code. Every value
below is a *first guess* introduced because the design spec is silent on it; the
number in code is the current value, and the note explains what it controls and
what to watch for in playtest. Changing any of these means editing
`shared/src/constants.ts` (the single source of truth) — never inline a literal
elsewhere.

## Milestone 4 — Fielding + Running (introduced 2026-07-03)

| Constant | Current value | Controls | Playtest watch-list |
|----------|---------------|----------|---------------------|
| `GAME.APPROACH_W` | `0.35` | Weight of the approach penalty subtracted from `pCatch` — how much a fast incoming ball hurts catch odds. | At 0.35 a 30 m/s+ screamer costs the full 0.35; a 10/10 fielder still catches ~0.65. If hard hits feel un-catchable, lower toward 0.25; if screamers are caught too easily, raise. |
| `GAME.APPROACH_REF_SPEED` | `30` (m/s) | Ball speed at which the approach penalty saturates (`clamp01(speed / ref)`). | Roughly the top hit exit velocity (HIT_MAX=40 × timing). If most in-play balls arrive well under 30 m/s the penalty rarely bites — consider lowering to ~25 so mid-pace hits feel meaningfully harder. |
| `GAME.THROW_RELEASE_DELAY_S` | `0.5` (s) | Gather-to-throw wind-up before a held ball is launched at the exposed post. | This is the runner's window to reach safety. Too low → almost every run-out lands; too high → runners are never caught. Tune against real post distances; QUICK_DRAW halves it in M9. |
| `GAME.SPRINT_STAMINA_COST_PER_S` | `0.15` (stamina/s) | Fielder stamina drained per second of sprinting. | Stamina is on a 1–10 scale; at 0.15/s a fielder loses ~1 point per 6.7 s of chasing. Only matters once multi-play innings (M5) carry stamina across plays — revisit then. |
| `GAME.THROW_STAMINA_COST` | `0.5` (stamina/throw) | Flat stamina cost of a throw. | Same as above: no felt effect within a single play (fatigue is static per play in M4). Sanity-check once fatigue accumulates in M5. |
| `GAME.CATCH_HEIGHT_MAX` | `2.5` (m) | Balls above this height are "over everyone's head" — no catch attempt. | A capsule fielder is ~1.4 m + reach; 2.5 m allows a modest jump/reach. If lofted hits are being caught unrealistically high, lower; if easy pop-ups sail uncaught, raise. |
| `FIELD.FIELDING_POSITIONS` | 9-slot placeholder layout | Default fielder standing positions (slot 0 = bowling square, slot 1 = backstop, 2–5 mind posts 1–4, 6–8 deep field). | Entirely provisional school-rounders geometry. Real positioning UI lands in M8; expect wholesale replacement. Note slot 0 must stay equal to `BOWLING_SQUARE` so the bowler and fielding slot 0 cannot drift apart. |

## Milestone 5 — Rules engine (observed 2026-07-03)

- **A live full rounder is unreachable with current tunables.** The post circuit
  is ~47.4 m (batting square → posts 1–4 at the placeholder coordinates) and the
  fastest roster runner covers ~6.35 m/s (Carl, speed 7 → `moveSpeed` 6.35 with
  full stamina), needing ~7.5 s — but `GAME.PLAY_TIMEOUT_S = 6` ends the play
  first, so `{kind:'rounder'}` (+2 halves) can never occur in a real play; the
  best live score is a half-rounder. The path is fully covered by RulesModule
  unit tests. **Still true after the 2026-07-05 ×2 field (real-speeds
  decision):** the circuit is now ~94.8 m and `PLAY_TIMEOUT_S` is 12 s — both
  roughly doubled in lockstep, so the same shortfall persists proportionally
  (a full circuit at the fastest runner's unchanged speed still needs
  ~15 s > 12 s). Fix candidates for playtest: raise `PLAY_TIMEOUT_S` to ~9 s (also
  fixes the M3 despawn-mid-air note below), shrink the post circuit, or raise
  `MOVE_MAX`. Tune together with `THROW_RELEASE_DELAY_S` — a longer play gives
  fielders more run-out windows, so rounders should stay rare, not impossible.

## Milestone 6 — Two-player sync (introduced 2026-07-04)

| Constant | Current value | Controls | Playtest watch-list |
|----------|---------------|----------|---------------------|
| `GAME.RECONNECT_GRACE_S` | `60` (s) | How long a mid-game disconnect pauses the match (simulation frozen, seat held) before the survivor is told the opponent left and the room disposes. | Pure first guess. Too short → a router blip ends real matches; too long → the survivor is hostage to a rage-quit that closed the tab uncleanly (no consented leave). Judge against real remote play: if most genuine drops reconnect within ~15 s, cut it; consider surfacing a countdown in the M10 UI before tuning further. Tests override via the `reconnectGraceS` room option rather than this constant. |

## Milestone 8 — Positioning (introduced 2026-07-04)

| Constant | Current value | Controls | Playtest watch-list |
|----------|---------------|----------|---------------------|
| `FIELD.LEGAL_ZONE` | `{minX: -20, maxX: 20, minZ: -6, maxZ: 32}` | Rectangular area a fielder may be repositioned into. | Placeholder like the rest of the field geometry — sized to contain the posts, the 9 default slots and a modest deep field within `GROUND_HALF_EXTENT` 40. If deep lofted hits routinely land beyond `maxZ` 32 un-fieldably, extend it (or shrink hit distances); if players park a wall of fielders on the boundary, consider a max-per-region rule rather than shrinking the zone. Tune together with the post coordinates. |
| `FIELD.BATTING_SQUARE_KEEPOUT` | `3` (m) | Minimum distance a repositioned fielder must keep from the batting square (exclusive: `dist > 3`; the backstop's DEFAULT slot at (0,−3) is exactly on the boundary and stays legal only because defaults aren't validated — moving him needs a spot outside 3 m). | Too small → a fielder camps the batter and swallows every flat drive off the bat; too large → no meaningful backstop/close-catcher play. 3 m is a first guess; judge against how often sub-5 m catches decide plays. |

- **Pitcher-change slot-0 overlap (M8, design-inherent).** Nominating a new
  bowler pins them to `PITCHING_SPOT`, but the displaced ex-pitcher's persisted
  layout position is still the bowling square (slot 0) — the two stand stacked
  until the fielding side manually repositions the ex-pitcher (CLAUDE.md §6.2).
  If playtest shows players never notice the stack, consider a UI nudge (or an
  auto-offset of a metre or two) rather than a rules change — any auto-placement
  invents a rule the spec doesn't give.

## Milestone 9 — Abilities (introduced 2026-07-04)

| Constant | Current value | Controls | Playtest watch-list |
|----------|---------------|----------|---------------------|
| `ABILITY.SPIN_READ_W` | `0.25` | Weight of the invented (USER-APPROVED) spin-read penalty on the swing timing window: `1 − SPIN_READ_W·s01(pitcherSpin)·|spinInput|` — SWITCH's counterpart mechanic (SWITCH batters are immune). | At 0.25 a max-spin pitch from a 10-spin bowler shrinks a batter's window by 25%. If spun pitches feel unhittable for non-SWITCH batters, lower toward 0.15; if SWITCH feels like a dead ability because spin barely matters, raise. Tune together with `CURVE_SPIN_MULT`. |
| `ABILITY.STATIONARY_SPEED_EPS` | `0.1` (m/s) | Speed below which a fielder counts as "stationary" for LONG_REACH's 1.4× catch-radius bonus. | Pure epsilon first guess — meant to distinguish "standing at their spot" from "chasing". If LONG_REACH fielders lose the bonus from tiny approach jitters, raise slightly; if they keep it while visibly drifting, lower. |
| `ABILITY.WALL_BLOCKER_HALF_HEIGHT` / `WALL_BLOCKER_RADIUS` | `0.9` / `0.4` (m) | Size of the whale's WALL blocker capsule (total height 2.6 m with caps) — the volume that stops a struck ball dead. | Spec is silent on size; whale-sized first guess. Too large → the whale blanks an entire corridor of the field; too small → WALL rarely triggers. Judge against how often flat drives through the whale's zone die at his feet, and tune together with the field geometry/`LEGAL_ZONE`. |

- **BUTTERFINGERS fumble dead-zone (M9 final-review observation).** A fumbled
  ball parks dead at the fumbler's FEET, but the fumbler's catch-roll latch
  stays set (deliberately — no instant re-roll on the parked ball), so the
  fumbler himself can never recover it; with nobody else nearer, the play
  simply ends at rest with the ball at his feet. Plausibly the intended
  Butterfingers flavour (the drop costs the fielding side the ball outright),
  noted here so it isn't rediscovered as a bug. If playtest wants recoverable
  fumbles, clear the fumbler's latch a beat after the fumble or let a
  teammate's arrival re-trigger the pickup.

- **CLUTCH-test timing headroom (~0.37 ticks).** The CLUTCH unit tests use
  absolute swing-offset thresholds that sit only ~0.37 of a physics tick inside
  the window edge they assert against. Deterministic today (fixed timestep,
  fixed inputs), but retuning `TIMING_W`, reflex stats, or pitch speeds can
  silently flip those tests before it flips gameplay — re-derive the test
  offsets alongside any timing-window retune.

## Auto-play redesign (introduced 2026-07-05)

Plays now resolve as server dice beats (no player play-messages), so the values
below ARE the felt pace and difficulty of a match — the primary playtest dials.

| Constant | Current value | Controls | Playtest watch-list |
|----------|---------------|----------|---------------------|
| `GAME.AUTOPLAY_PITCH_DELAY_S` | `1.0` (s, sim time) | Delay after PLAY entry (or a no-contact respawn) before the auto pitch beat fires. | The match's breathing room: long enough to read the previous roll banner, short enough that a missed-swing re-pitch loop doesn't drag. If spectating feels rushed, raise toward 1.5; if plays with several misses feel dead, lower the RESPAWN case specifically (would need a second constant). |
| `GAME.AUTOPLAY_BEAT_MIN_GAP_S` | `0.6` (s, sim time) | Rate limit between consecutive RUN roll broadcasts (decisions still apply when the broadcast is suppressed). | Presentation-only. Too low → banner spam during multi-runner cascades; too high → runs feel undecided. Tune against the 1.4 s banner life (2 max stacked). |
| `GAME.AUTOPLAY_TIMING_NOISE_S` | `0.3` (s) | The auto-batter's swing timing error is sampled uniform in ±this; contact iff the error lands inside the batter's REAL effective window (the full resolveSwing chain — reflex, CANNON_ARM, spin-read, pressure). | The single biggest game-pace dial: at 0.3 a mid-reflex batter connects roughly every other pitch. Lower → more contact, faster innings, abilities that shrink windows matter less; higher → miss-heavy, slower games. Retune alongside `TIMING_W` only — the window chain itself is shared with the formulas. |
| `GAME.AUTOPLAY_RUN_BASE` | `0.3` | Runner AI base term in `pGo = clamp01(BASE + safety01·0.5 + NERVE_W·s01(nerve))`. | The floor of runner boldness. If runners feel suicidal into held balls, lower; if innings stall on timid runners, raise. |
| `GAME.AUTOPLAY_RUN_NERVE_W` | `0.3` | Weight of the runner's nerve stat in `pGo`. | Differentiates the roster: at 0.3 the nerve-1→10 spread is 27 percentage points of go-probability. Raise to make nerve a defining stat, lower if low-nerve characters never advance. |
| `GAME.AUTOPLAY_RUN_HELD_RISK` | `0.15` | The (low) fixed SAFETY value used while a fielder holds the ball — it replaces the distance-based safety term, so a held ball contributes only `0.15·0.5` to `pGo`. | Too high → runners sprint into held-ball run-outs constantly; too low (with a low BASE) → the game freezes whenever the ball is gathered. Tune together with `THROW_RELEASE_DELAY_S` (the actual run-out window). |
| `GAME.AUTOPLAY_RUN_DIST_REF` | `30` (m) | Ball-to-target-post distance at which the distance-based safety term saturates at 1 (`safety01 = clamp01(dist / REF)` — a FAR ball means a SAFE run). | Roughly the deep-field-to-post throw. If runners won't go on mid-field balls, lower it (mid distances read safer); if they run into close balls too readily, raise. |

- **Beat pacing overall:** a resolved play currently runs ~4–12 s (pitch delay +
  flight + running + rolls; live acceptance: a 24-play game in ~3.5 min
  including re-pitch loops). Judge the whole rhythm — pitch delay, banner life
  (1.4 s, max 2 stacked), run-roll gap — together, as one broadcast-pacing
  decision, not constant by constant.

## Readable-game overhaul (introduced 2026-07-05)

The whole-stack pacing/fairness/presentation pass: the field doubled in size
(real speeds unchanged, so plays simply take longer to unfold and are easier
to watch/read), auto-hit shots now get real loft, a hit ball is uncatchable
until it clears a launch-point radius, fielders relay-throw one hop when a
teammate is meaningfully closer to the threatened post, a missed swing
respawns fast instead of waiting to roll to rest, and a resolved play holds
its "death tableau" for a beat before the field resets. These constants ARE
the felt pace of a match now — the primary playtest dials alongside the
auto-play ones above.

| Constant | Current value | Controls | Playtest watch-list |
|----------|---------------|----------|---------------------|
| `FIELD.*` ×2 scaling (`POSTS`, `FIELDING_POSITIONS`, `LEGAL_ZONE`, `BATTING_SQUARE_KEEPOUT` → 6, `GROUND_HALF_EXTENT` → 80) | doubled from the M1 placeholder geometry | The whole field's footprint; movement/throw/pitch SPEEDS deliberately NOT scaled (user decision: "real speeds on a bigger field"), so every flight/run/throw RATIO changed. | This is the single biggest felt-pace lever now. If plays still feel too fast/slow after the ×2, the next dial is here, not the auto-play beat constants — but change it together with `PLAY_TIMEOUT_S`/`AUTOPLAY_RUN_DIST_REF` below (they were scaled in lockstep and will drift out of proportion if the field is retuned alone). Square SIZES and `POST_SENSOR_RADIUS` are deliberately UNSCALED (markings/contact semantics, not distances). |
| `GAME.PLAY_TIMEOUT_S` | `12` (was 6) | Doubled in lockstep with the field so a play still has time to resolve at the old speeds over the new distances. | The M5-era "a live rounder is unreachable" note should be re-examined at this value (the circuit is now ~2× longer but so is the timeout) — worth a dedicated playtest check now rather than assuming it cancels out exactly. |
| `GAME.AUTOPLAY_RUN_DIST_REF` | `60` (was 30) | Ball-to-target-post distance at which the runner AI's distance-based safety term saturates. | Scaled ×2 with the field so runner boldness reads the same relative distances as before; if runners feel newly timid/bold on the bigger field, this is the first constant to revisit before touching `AUTOPLAY_RUN_BASE`/`AUTOPLAY_RUN_NERVE_W`. |
| `GAME.AUTOPLAY_PITCH_DELAY_S` | `1.5` (was 1.0) | Delay after PLAY entry (or a no-contact respawn) before the auto pitch beat fires. | Raised as part of the readable-pacing retune (target band 8–15 s/play). Judge together with `AUTOPLAY_BEAT_MIN_GAP_S` below and the acceptance-measured pacing distribution (`docs/superpowers/acceptance/readable-acceptance.txt`) — if the measured median sits outside 8–15 s, this is the first lever. |
| `GAME.AUTOPLAY_BEAT_MIN_GAP_S` | `1.0` (was 0.6) | Rate limit between consecutive RUN roll broadcasts. | Raised alongside the pitch delay for the same readable-pacing retune; same tuning caveat as above. |
| `GAME.AUTOPLAY_LOFT_MIN_DEG` / `AUTOPLAY_LOFT_MAX_DEG` | `5` / `50` | The auto-batter's swing decision now samples a REAL launch elevation in this band (previously every auto-hit was a 0°-forever line drive — bug investigation Bug B). Deliberately strictly inside `HIT_ELEVATION_MIN/MAX_DEG` (−10°/60°) so the sample survives HitModule's clamp unchanged. | First-guess band. If hits read as too pop-fly-heavy (easy catches) or too flat (nothing airborne), narrow/shift the band; watch the acceptance-logged elevation distribution as the baseline. |
| `GAME.CATCH_ARM_DISTANCE_M` | `4` (m) | A hit flight is uncatchable (no catch/gather attempt, no rng draw) until it has travelled this far from its launch point. Throw flights are exempt (armed immediately) so relay catches stay live. | Kills the "caught without hitting" backstop instant-catch bug (bug investigation Bug A: every auto-hit launched at exactly the contact point, inside the backstop's radius, so her entry roll fired before the ball visibly left the bat). If close-in dribblers still feel unfairly uncatchable-then-suddenly-catchable at the 4 m boundary, this is the dial; the acceptance harness watches for and logs any sub-4 m "unfieldable dribble" oddity (a very weak hit that neither arms in time nor rolls anywhere useful) as an ACCEPTANCE WATCH item, not a fix. |
| `GAME.RELAY_ADVANTAGE_M` | `6` (m) | A holder throws to a teammate instead of the threatened post when that teammate is at least this many metres closer to the post AND closer than the holder's own throw distance. One-hop only (no multi-link planning). | First guess. Too low → relays happen constantly, diluting the direct-throw run-out tension; too high → relays almost never trigger even when geometrically sensible. The Task-1 review logged a "far-side relay lob geometry" observation (a relay target chosen purely by post-distance can occasionally sit an awkward lob's distance from the holder) — watch for visually odd throw arcs in playtest, not a correctness bug (the throw solver already falls back to a 45° lob for out-of-range targets). |
| `GAME.MISS_RESPAWN_S` | `1.5` (s, sim time) | A missed swing (no contact) respawns the ball for the re-pitch after this delay instead of waiting for the dead flight to roll to rest (the old path took ~7 s). | Straightforward pacing dial — this is now the dominant cost of a miss-heavy play (several re-pitch loops in a row). If miss-heavy innings still drag, lower it; if re-pitches feel rushed/jarring, raise it — but keep it well under `PLAY_TIMEOUT_S`. |
| `GAME.OUTCOME_HOLD_S` | `1.5` (s, sim time) | After a play resolves, the broadcast fires immediately but the ball/fielders/runners are held exactly where the play died for this long before the field resets — a readable "how did that end" tableau. Pause-safe (sim time) and rematch/GAME_OVER-safe (see the §6.2 decision row). | The whole point of this constant is legibility, not fairness — tune purely by feel. Too short and the old instant-teleport problem effectively returns; too long and the game feels laggy between plays. GAME_OVER holds too (the frozen final play IS the result tableau) before the result overlay's phase flip — if that reads as a delayed/broken result screen in playtest, this is the first thing to check before touching UIModule. |

- **Sub-4 m dribble / far-side relay lob (Task 1 review, ACCEPTANCE WATCH, not a defect).** Two geometry edge-cases flagged during review rather than fixed: (1) a very weak hit that dies (rolls to rest) before travelling `CATCH_ARM_DISTANCE_M` can end a play essentially unfieldable-by-design (nobody may attempt a catch on it at all, and it's too close/slow to be a meaningful run situation either) — the readable-acceptance harness watches for this pattern and logs it if seen, rather than treating it as a bug; if playtest finds it common/annoying, consider a MIN hit speed/distance floor on contact as a separate change (out of this milestone's scope). (2) a chosen relay target can occasionally sit at an aesthetically odd throw angle from the holder (the qualifying inequality is purely about post-distance, not about producing a "clean" throw line) — the throw solver's existing 45°-lob fallback for out-of-range geometry covers the mechanical case; a genuinely bad-looking relay lob is a presentation nit to watch for, not a rule change.

## Carried over from earlier milestones

- **Max-power hit vs `PLAY_TIMEOUT_S` (M3).** A max-power 60°-elevation hit flies
  ~6.0 s, which is right at `GAME.PLAY_TIMEOUT_S = 6` — the ball can be despawned
  mid-air at the extreme. Either raise `PLAY_TIMEOUT_S` (e.g. to 8 s) or cap
  elevation/power interaction once real hit distributions are observed in
  playtest. (Originally logged in CLAUDE.md §6.4.)

## Field geometry (M1, still provisional)

- `FIELD.POSTS`, `FIELD.BATTING_SQUARE`, `FIELD.BOWLING_SQUARE`,
  `FIELD.POST_SENSOR_RADIUS`, `FIELD.POST_HEIGHT` are placeholder school-rounders
  values (CLAUDE.md §6.2). Post distances directly govern how often the
  throw-vs-runner race in a run-out is winnable, so tune `THROW_RELEASE_DELAY_S`
  and the post coordinates together.
