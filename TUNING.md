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
