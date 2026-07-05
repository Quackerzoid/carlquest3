# Bug investigation — "play accelerates" (A) and "caught out without hitting" (B)

Date: 2026-07-05. Repo: D:\carlquest3\carlquest3, main @ bde1928. Read-only on src.

## Method / evidence sources

1. Code trace: `server/src/rooms/MatchRoom.ts` (autoPitch/applyAutoSwing/autoRunBeat/endPlay/tick),
   `server/src/modules/AutoPlayModule.ts`, `FieldingModule.ts`, `HitModule.ts`, `PhysicsModule.ts`,
   `shared/src/{formulas,constants,characters}.ts`, `client/src/RenderModule.ts` (lerp), `UIModule.ts` (banners).
2. Committed acceptance log `docs/superpowers/acceptance/autoplay-acceptance.txt` (timestamps, 24 plays).
3. **Live instrumented run** (this session): temp server entry on port 2569 (2567 squatted by the stale pair;
   entry mirrored `server/src/index.ts`, deleted after), scratch harness `bug-harness.mjs` — a full seeded
   game (seed 1, 20 plays, A 3 – B 1) with two scripted clients recording every `roll` broadcast, every
   `playOutcome`, and every state patch (ball pos/vel, all fielder/runner positions).
   Raw output: `bug-harness-run1.txt` (same scratchpad).

---

## Bug A — "play instantly accelerates when a fielder grabs the ball"

### Verdict: Hypothesis 1 REJECTED; Hypotheses 2 + 3 CONFIRMED (they compound).

**H1 — SIM_MAX_CATCHUP bursts: REJECTED.** Across 2,011 consecutive patch pairs during live PLAY, the ratio
`ball displacement / (|v| × wall-dt)` had median **1.06**, p95 **1.36** — the sim advances at 1:1 real time.
Only 5/2011 pairs exceeded 2.5, and each coincides with a mid-patch velocity *replacement* (the hit at the
plane crossing / a throw release changes v discontinuously between two patches), not an event-loop stall.
No catch-up burst was observed anywhere near gathers.

**H2 — post-gather beat compression: CONFIRMED.** Time from the last *successful* catch/gather roll to
`playOutcome`, per play (16 plays with a catch/gather):

- 13 × **0.00 s** (caught → the play resolves in the *same tick* as the catch; also one 0.00 s runOut —
  the gatherer stood inside the exposed post's 0.5 m sensor, `holderNearPost` fires the gather tick)
- runOut plays: 0.82 s and 0.94 s (gather → 0.5 s `THROW_RELEASE_DELAY_S` → ~30 m/s dart → sensor)
- median 0.00 s, max 0.94 s.

So from the moment a fielder "reaches the ball and grabs it", the play is over within **at most ~1 s**,
usually instantly.

**H3 — the endPlay snap rendered by the fast client lerp: CONFIRMED — this is the "impossible speed" the
user sees.** `endPlay` synchronously does `fielding.reset()` + `rebuildFielding()` + runner settle/delete:
every figure's schema position jumps to its slot in one patch. Measured: **22 fielder patch-moves faster
than 12 m/s, ALL 22 within 0.3 s of a playOutcome** — worst cases 31.0 m, 30.7 m, 27.2 m, 25.3 m in a
single ~60 ms patch (400–500 m/s apparent server-side), plus 5 runner snaps. The client lerp
(`convergeFactor = 1 − 0.001^dt`, half-life ≈ 0.10 s, RenderModule.ts:18/47) plays each snap back as a
~0.3–0.5 s whoosh — a fielder visually "sprints" 30 m at ~60–100 m/s. MOVE_MAX (legit sprint) is 8 m/s.

**Where the perceived acceleration actually comes from:** correct-speed sim → gather → (≤1 s, usually 0 s)
resolution → same-instant whole-field teleport back to slots, smoothed over ~0.3 s by the lerp. The
contrast is amplified by pacing: a missed-swing cycle is ~7.0 s of watching the ball roll to rest
(rest-detect + 1 s + `AUTOPLAY_PITCH_DELAY_S`), then the decisive action compresses into 0.2–1 s.

---

## Bug B — "caught out without hitting the ball"

### Verdict: NOT a caught-without-contact rules bug — but a REAL gameplay defect that looks exactly like one: the backstop instant-catches the ball AT THE MOMENT OF CONTACT, before it visibly leaves the bat.

**No-contact path is impossible in code (verified):** `FieldingModule.tick` runs only under `contactMade`
(MatchRoom.tick:958), which is set only when `resolveSwing` returns `contact:true` (applyAutoSwing:746);
the missed-swing branch (tick:986-996) never touches fielding and produces no resolution. The swing roll's
broadcast `success` is recomputed from the actual contact result (applyAutoSwing:741). Live check across
20 plays: **0 plays where a `caught` outcome lacked a preceding success=true swing roll**; the committed
acceptance's per-play sequence collector asserted the same invariant across its 24 plays.

**The real mechanism (measured):** in the live game, **13 of 15 `caught` outcomes resolved 0.00 s after the
successful swing** — the swing roll, run roll, catch roll and playOutcome all share one timestamp, e.g.:

```
play 16: [138.85] swing kian OK — timing +0.024s v window 0.165s   (timingFactor 0.85 — a WELL-STRUCK hit)
         [138.85] run kian OK
         [138.85] catch laurie OK — pCatch 0.56
         playOutcome caught by laurie @ 138.8
```

Geometry chain:

1. `AutoPlayModule.swingDecision` aims at a post with **y = 0** (AutoPlayModule.ts:134) → after
   `normaliseAim`'s clamp (−10°..60°, 0 is legal) **every auto hit launches at exactly 0° elevation** from
   the contact point (~y 0.6 m, z 0 to −0.47 m past the plane).
2. The backstop slot is (0, −3) — 3 m behind the batter (constants.ts FIELDING_POSITIONS[1]). Laurie
   (reach 9, LONG_REACH ×1.4 stationary) has catch radius **3.89 m**; her hands at (0, 1, −3) are ~2.6–3.05 m
   from the contact point → **the ball is already inside her radius the instant the bat connects**. Josh
   (reach 7, radius 2.34 m) is marginal at contact and inside within 1–2 ticks for weak/medium hits.
3. `FieldingModule` rolls pCatch on radius **entry** — and "entry" includes the ball simply *starting* the
   hit flight inside the radius (the latch is evaluated the first fielding tick, which IS the contact tick;
   there is no reaction delay and no check that the ball is moving toward the fielder — the hit points AWAY
   from the backstop, at the posts). `hasBounced()` is false → classified `caught`, batter out.
4. pCatch for laurie = 0.3 + 0.4·0.8 + 0.3·0.7 − 0.35·(v/30) ≈ 0.56–0.76 → **the majority of all contact
   hits against a laurie/josh backstop die at the batting square in the same broadcast batch as the swing.**
   In the live game laurie took 8 of A's... (B's) outs this way, josh 3.

From the player's seat: pitch arrives → "CONNECTS!" banner and "TAKEN!" banner land together, the ball never
visibly travels, batter out. That reads as "caught without hitting". Weak contact compounds it (25% of
contacts had timingFactor < 0.3 → exit < ~8 m/s dribbles; 50% < 0.5), but the instant-backstop-catch fires
on *well-struck* hits too (play 16 above, tf 0.85, exit ~21 m/s), so it is not merely a perception issue
about dribbles — the outcome itself is degenerate.

Also note: with 0° elevation the entire flight stays below CATCH_HEIGHT_MAX 2.5 m, so every hit ball is
catchable along its whole pre-bounce path, and swing aims target the posts — where the post-minding
fielders stand ~1.4 m away. Caught is structurally the dominant outcome (15/20 plays here; the committed
game similarly caught-heavy).

---

## Measurements for the redesign

**Play duration (pitch beat availability → playOutcome, i.e. PLAY entry → outcome):**
- Committed acceptance log (25 resolutions): min 1.2 s, median 8.2 s, mean 8.7 s, max 35.1 s.
- Live run (20 plays): min 1.2, median 8.2, max 29.3 —
  `1.2 1.2 1.2 1.3 2.3 3.2 7.0 7.0 8.2×5 8.3 9.6 10.1 11.7 14.0 14.1 29.3`.
- Structure: first-swing-contact plays resolve in **1.2–3.2 s** (1.0 s pitch delay + ~0.27 s flight +
  instant/near-instant catch or short chase). Each missed swing adds a **~7.0 s dead cycle** (ball rolls to
  rest ~5.7 s + 1 s rest confirm + 1.0 s re-pitch delay — measured pitch-to-repitch 45.73→52.74 s etc.).
  Long plays (14–35 s) are 2–4 miss cycles; the 8.2 s mode is exactly one miss + instant catch.

**Hit elevation / loft distribution: 100% ground-level line drives, 0% lofted — deterministic.**
`swingDecision` builds `aim = {x: post.x, y: 0, z: post.z}` (AutoPlayModule.ts:134); `normaliseAim` clamps
y within [tan −10°, tan 60°]·horizontal, so y = 0 passes through unchanged. Every auto hit leaves the bat at
exactly 0° from ~0.6 m height: airborne ≤ ~0.45 s, first bounce within 0.45·exitSpeed metres (≈2 m for a
dribble, ≈13 m for a max hit). The HIT_ELEVATION_MAX_DEG = 60° head-room is dead code under auto-play; no
hit can ever be a catchable-high loft or clear the infield in the air.

---

## Recommended fix directions

- **A (endPlay snap):** don't teleport at resolution — hold the final tableau for a presentation beat
  (~1–1.5 s, like the runner-topple retention) and/or have fielders *walk* back to slots during PRE_PLAY
  instead of `fielding.reset()` snapping positions in the outcome patch.
- **A (beat compression):** insert minimum presentation gaps between gather → throw → resolution (reuse
  `AUTOPLAY_BEAT_MIN_GAP_S` as an actual beat pacer, not just a broadcast rate-limit), so the decisive
  action is watchable at human speed.
- **B (instant backstop catch):** suppress catch attempts for a short arm-time after `applyHit` (e.g. no
  catch rolls for the flight's first N ticks / until the ball has travelled ≥ BATTING_SQUARE_KEEPOUT), or
  require radius *entry from outside* (a flight starting inside a radius shouldn't count as an entry —
  the same idea as the WALL flight-start exemption).
- **B/loft:** sample a real elevation in `swingDecision` (e.g. timing-quality-weighted 0–45°) so hits loft,
  vary, and can clear the infield — this also diversifies outcomes away from caught-dominance and makes
  weak vs strong contact visually readable.
- **Pacing:** kill the 7 s missed-swing dead time — respawn the ball once it is behind the batter by a few
  metres rather than waiting for full rest + 1 s.

## Cleanup

Temp server entry `server/serve2569.tmp.ts` deleted (repo clean); temp server process (PID 25528, port 2569)
killed. Harness + raw log remain in the scratchpad (`bug-harness.mjs`, `bug-harness-run1.txt`).
