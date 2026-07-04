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
  unit tests. Fix candidates for playtest: raise `PLAY_TIMEOUT_S` to ~9 s (also
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

- **CLUTCH-test timing headroom (~0.37 ticks).** The CLUTCH unit tests use
  absolute swing-offset thresholds that sit only ~0.37 of a physics tick inside
  the window edge they assert against. Deterministic today (fixed timestep,
  fixed inputs), but retuning `TIMING_W`, reflex stats, or pitch speeds can
  silently flip those tests before it flips gameplay — re-derive the test
  offsets alongside any timing-window retune.

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
