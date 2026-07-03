# Milestone 5 — Rules Engine Design (RulesModule + multi-runner + phase machine)

Spec sources: design spec §2 (phase machine), §8 (rounders rules), §8b (defaults), §7 (message/phase validation), §5 (pressureMult). Milestone: §9.5 — "RulesModule: full innings/outs/scoring state machine, single-player end-to-end."

## User decisions (2026-07-03, this session)

1. **Half-rounder** = reaching 2nd post (but not 4th) on your **own hit** scores ½; reaching 4th post in one hit scores 1 (the ½ is subsumed, not additive). A runner completing the circuit on a later play scores nothing extra.
2. **Multi-runner, shared stop/go, full school rules**: previous batters parked on posts run again under the same R/T go/stop commands as the new batter-runner; a runner must vacate a post when the following runner arrives (forced on); any moving runner can be run out at their exposed post.
3. **No-balls deferred** — every pitch is legal in M5; logged spec gap (criteria undefined in the design spec).
4. **Tie → sudden-death play pairs**: each side bats one play alternately; the first pair ending with a score differential decides the game; repeat until broken.

## Architecture

Three work fronts, in dependency order:

### 1. Shared contracts (`/shared`)

- **Score in half-units** (integer count of half-rounders; rounder = 2) — avoids floats in schema and tests.
- New types: `TeamSide = 'A' | 'B'`; `PlayResolution` — the rules-level result of a play: `{ cause: PlayOutcome; outs: string[]; scoreDeltaHalves: number; batterId: string }`. The M4 physical `PlayOutcome` union is unchanged as the *cause*; `runOut`/`safe` gain a `runnerId` field so multi-runner causes name their runner.
- `RunnerView` gains per-runner identity in a list (see RunningModule) — schema mirrors it.
- No new tunables expected (INNINGS_COUNT, SQUAD_SIZE, BENCH_SIZE, SUBS_PER_* already pinned). `PRESSURE_*` weights already exist inside `pressureMult` (M3 formulas).

### 2. RunningModule — multi-runner extension (`/server`)

Single owner of all runner movement and run-out exposure.

- State: `runners: Runner[]` (id, character, position, atPost, targetPost, out, home, `ownHitPlay: boolean` — true only for the batter-runner of the current play, `highestPostThisPlay` for half-rounder banking).
- `startRun(character)` — spawns the new batter-runner at the batting square (auto-run to post 1, as M4); parked runners keep their posts.
- `setDecision(go)` — applies to **all** live runners not at home/out (shared command). Stop arms halt-at-next-post per runner; go resumes all parked/halted runners.
- **Forced on**: when runner R arrives at (or passes through) a post occupied by runner S, S is immediately forced to run towards the next post (auto-go), regardless of an armed stop. Two runners never occupy one post.
- `exposures(): { runnerId: string; post: number }[]` — every mid-segment runner's target post (replaces M4 `exposedPost()`; a compatibility wrapper is NOT kept — call sites update).
- `markOut(runnerId)` — now used (multi-runner: one runner out must not reset the others; play may end via first-outcome-wins, but the runner-level flag matters for PLAY_RESOLVE bookkeeping).
- Post-4 arrival: runner `home = true`; whether it scores is RulesModule's decision (own-hit or not).
- `reset()` semantics change: **end of play no longer clears all runners** — the room instead calls `settlePlay()`, which removes home/out runners and *parks* survivors at their current post (mid-segment survivors settle back to the previous post, consistent with the M4 safe-at-previous-post rule, logged §6.2). Full `reset()` remains for innings switch/rematch.

### 3. RulesModule (`/server`) — pure state machine, no Colyseus imports

- `createRulesModule(config: { squadA: Character[]; squadB: Character[]; inningsCount?: number })`.
- Owns: `phase` (the shared `MatchPhase`), innings index, batting side, per-side score (halves), per-side per-player out flags, batting queue (order = squad order; players who come home rejoin the back; out players leave), current batter, tiebreak state.
- Phase transitions exactly per spec §2. LOBBY→DRAFT→INITIAL_POSITIONING advance via stub confirmations in M5 (draft is M7, positioning M8): the room auto-confirms DRAFT with the configured demo squads and treats a `confirmPositioning` message as the INITIAL_POSITIONING gate.
- `PRE_PLAY` → `PLAY` on `readyForPlay` (M5: one confirmation suffices — role gating is M6/M7, logged).
- `PLAY` ends with a physical `PlayOutcome` (from the room's M4 outcome resolution); `resolvePlay(cause, runnerFacts)` runs in `PLAY_RESOLVE`: applies outs (caught → batter out; runOut → that runner out), banks score for home runners (own-hit: 4th post = 2 halves; ≥2nd post at play end = 1 half; later-play completions = 0), parks survivors, picks the next batter, then transitions: innings continues → `PRE_PLAY`; batting side all out **or batting queue empty** (no one left to bat; stranded runners score nothing — logged decision) → `INNINGS_SWITCH`; final innings complete → `GAME_OVER` unless tied → sudden-death pairs (modelled as extra PRE_PLAY/PLAY/PLAY_RESOLVE cycles with a `tiebreak` flag; no new MatchPhase).
- Innings order with `INNINGS_COUNT = 2`: A, B, A, B (each side bats twice). `isFinalInnings()` = the last A/B pair (or any tiebreak play) — the hook CLUTCH_SWING needs in M9.
- `pressure(): boolean` = `isFinalInnings() OR runners on 2+ posts` — **M5 wires `pressureMult` in** (spec §5): HitModule timing factor and FieldingModule pCatch both multiply by `pressureMult(nerve)` when the rules module reports pressure (M4 left it unused pending this milestone).
- Out conditions in M5: caught (pre-bounce), run-out. "Running inside a post" is structurally impossible with straight post-to-post segments — logged N/A for M5.
- No-ball: absent (user decision 3).

### 4. MatchRoom integration

- The M3/M4 LOBBY demo loop is replaced by the real phase machine; `demoLog` (§6.4 stringly placeholder) is replaced by structured events: schema `phase`, per-side score/outs/innings, current batter/pitcher ids, a `runners` ArraySchema, and broadcast `playOutcome` carrying the `PlayResolution`.
- **Every message phase-validated** (spec §7): `pitch`/`swing`/`runDecision` only in PLAY, `readyForPlay` only in PRE_PLAY, `confirmPositioning` only in INITIAL_POSITIONING, `rematch` only in GAME_OVER; everything else rejected with a structured rejection event (tests assert rejection).
- Run-out check generalises to per-runner exposures: the M4 detection machinery (event-latched `wasBallAtPost` scoped to the exposure window + `isBallAtPost` + holder-at-post) runs **per exposed runner**; the exposure-window latch clearing keys on the *set* of exposures changing. First outcome still ends the play (school rules would let play continue after an out until the ball is dead; keeping M4's first-outcome-wins is a logged simplification to revisit if playtesting demands).
- Demo squads for single-player M5: **mirror rosters** — both sides use the full 11-character table in order (batting order = table order; fielding nine = first 9 non-batting arrangement as M4). A real draft cannot give both sides 11 of 11 characters — the spec's SQUAD_SIZE 9 + BENCH 2 vs 11-character shared-pool draft is contradictory and is flagged as an **open question for M7**, not solved here.
- Fatigue bookkeeping across plays begins to matter (multi-play innings): fielder sprint/throw drains persist across plays within an innings; `BENCH_STAMINA_REGEN` still inert until substitutions exist (M8) — logged.

### 5. Client (minimal, no styled UI — M10)

- Status line: phase, score A/B (in rounders, halves shown as ½), innings, outs, current batter; existing keys unchanged; **Enter** → `confirmPositioning`/`readyForPlay` (whichever the phase wants), **N** → `rematch` at GAME_OVER.
- RenderModule: runner mesh becomes a per-runner map (same add/remove reconciliation as fielders).

## Testing

- **RulesModule unit tests** (pure, no Rapier/Colyseus): every §2 transition incl. rematch loop; scoring table (own-hit 4th = 2 halves, own-hit 2nd..3rd = 1 half, later completion = 0); outs bookkeeping; innings end on all-out AND on empty queue with stranded runners; A,B,A,B innings order; isFinalInnings; tie detection → sudden-death pairs → resolution; pressure() truth table.
- **RunningModule multi-runner tests**: shared go/stop across N runners; forced-on at an occupied post (incl. cascade: three runners); per-runner exposures; markOut isolation; settlePlay parking (mid-segment → previous post) vs reset; own-hit/highest-post tracking.
- **MatchRoom integration**: full single-player game driven headlessly to GAME_OVER (both innings, scores accumulate); out-of-phase message rejection for every message type (completion requirement); structured playOutcome events; rematch resets to INITIAL_POSITIONING.
- **Acceptance (§9.5)**: scripted WS client over a real server plays a complete single-player game end-to-end — pitches, hits, runs, outs, innings switch, final score, GAME_OVER — logging each phase transition and PlayResolution received.

## Open questions deliberately deferred

- M7 draft-pool arithmetic (SQUAD_SIZE 9 + BENCH 2 per side vs 11 shared characters) — raise during M7 brainstorming.
- No-ball criteria (user decision 3).
- First-outcome-wins vs ball-dead play continuation — revisit with playtesting.
