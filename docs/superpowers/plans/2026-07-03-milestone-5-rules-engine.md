# Milestone 5 — Rules Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Execute with TDD (failing test first). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A complete single-player game runs end-to-end through the spec §2 phase machine — innings, outs, scoring (rounders and half-rounders), multi-runner running, innings switch, tie-break, GAME_OVER and rematch — with every network message phase-validated.

**Architecture:** Design doc: `docs/superpowers/specs/2026-07-03-rules-engine-design.md` — read it first; it records the four USER-APPROVED rules decisions and all scope notes. RulesModule is a pure state machine (no Colyseus imports); RunningModule extends to N runners and stays the single owner of movement/exposure; MatchRoom replaces the M3/M4 demo loop with the real phase machine and structured events; pressureMult (§5) is wired into swing timing and pCatch.

**Tech stack:** unchanged (no new dependencies).

## Global Constraints

- TypeScript `strict: true`; no `any` / `@ts-ignore` without a justifying comment.
- Every number from `CONST`; §5 formulas used exactly (`pressureMult` joins timing + pCatch this milestone).
- Abilities stay neutral defaults (M9). No-balls are OUT OF SCOPE (user decision).
- Determinism: injected seeded RNG only; no wall-clock beyond the logged room-seed exception.
- Server-authoritative; every client→server message validated against the current phase (spec §7); malformed/out-of-phase payloads must be rejected without crashing (regression class).
- Score is stored in HALF-ROUNDER integer units (rounder = 2, half = 1) — no floats.
- Scoring rules (USER-APPROVED): own-hit runner home in one hit = 2 halves; own-hit runner whose highest post this play ≥ 2 (but not home) = 1 half at play end; a runner completing the circuit on a later play = 0. Innings ends when all batting-side players are out OR the batting queue is empty (stranded runners score 0). Innings order A,B,A,B with `INNINGS_COUNT = 2`. Tie after final innings → sudden-death play pairs.
- First outcome still ends the play (M4 semantics, logged simplification).
- British English. Conventional commits. `npm run check` green before every commit.

## File Structure

```
shared/src/types.ts                MODIFY  +TeamSide, PlayResolution; runnerId on runOut/safe
shared/test/types-or-constants     MODIFY  pin new shapes
server/src/modules/RunningModule.ts MODIFY  multi-runner rewrite (same file, same factory name)
server/test/RunningModule.test.ts   MODIFY  multi-runner suite
server/src/modules/RulesModule.ts   CREATE  pure state machine
server/test/RulesModule.test.ts     CREATE
server/src/modules/HitModule.ts     MODIFY  pressureMult param
server/src/modules/FieldingModule.ts MODIFY pressure dep
server/test/{HitModule,FieldingModule}.test.ts MODIFY
server/src/rooms/MatchState.ts      MODIFY  +score/innings/outs/batter/pitcher/runners list/winner
server/src/rooms/MatchRoom.ts       MODIFY  phase machine, message validation, per-runner run-out
server/test/MatchRoom.test.ts       MODIFY  major migration (demo-loop tests → phase-machine tests)
client/src/{RenderModule,InputModule,NetModule,main}.ts MODIFY  status line, Enter/N, runner map
CLAUDE.md / TUNING.md               MODIFY  Task 7
```

Task order: 1 → (2 ∥ 3 ∥ 4) → 5 → 6 → 7. Tasks 2, 3, 4 touch disjoint files and consume only Task 1's contracts — dispatch in parallel.

---

### Task 1: Shared contracts

**Files:** modify `shared/src/types.ts`, `shared/src/index.ts` (re-export if needed), `shared/test/constants.test.ts` or a new `shared/test/types.test.ts`.

**Produces (later tasks import from `@carlquest/shared`):**

```ts
export type TeamSide = 'A' | 'B';
export type PlayOutcome =
  | { kind: 'caught'; by: string }
  | { kind: 'runOut'; atPost: number; runnerId: string }   // runnerId NEW
  | { kind: 'safe'; atPost: number; runnerId: string }     // runnerId NEW = batter-runner of the play
  | { kind: 'rounder' };
export interface PlayResolution {
  cause: PlayOutcome;
  outs: string[];             // character ids put out this play
  scoreDeltaHalves: number;   // integer half-rounders banked this play
  batterId: string;           // who batted this play
}
/** Per-runner facts RunningModule.settlePlay() reports and RulesModule.resolvePlay() consumes.
 *  Lives in /shared so Tasks 2 and 3 (parallel) both import it from here, not from each other. */
export interface SettlementFact {
  runnerId: string; ownHit: boolean; highestPost: number; home: boolean; out: boolean;
}
```

**Steps:**
- [ ] Failing tests: PlayResolution shape compiles and round-trips JSON; runOut/safe require runnerId (type-level: a `@ts-expect-error` construction without runnerId).
- [ ] Implement; update the two M4 call sites that construct runOut/safe (`server/src/rooms/MatchRoom.ts`) minimally so the workspace still typechecks — supply the current single runner's id (full multi-runner wiring is Task 5).
- [ ] `npm run check` green; commit.

---

### Task 2: RunningModule — multi-runner (parallel-safe with 3, 4)

**Files:** modify `server/src/modules/RunningModule.ts`, `server/test/RunningModule.test.ts`.

**Produces:**

```ts
export interface RunnerView {
  id: string;                       // character id (unique per side in M5 demo)
  x: number; z: number;
  atPost: number | null;            // 0 = batting square, 1–4; null between posts
  targetPost: number | null;
  out: boolean; home: boolean;
  ownHitPlay: boolean;              // true only for the batter-runner of the current play
  highestPostThisPlay: number;      // 0..4, monotonic within a play
}
// SettlementFact comes from @carlquest/shared (Task 1).
export function createRunningModule(): {
  startRun(character: Character): void;         // spawns batter-runner at batting square (auto-run); parked runners unchanged
  setDecision(go: boolean): void;               // applies to ALL live (not home/out) runners
  tick(dt: number): void;
  markOut(runnerId: string): void;              // that runner only; others unaffected
  runners(): RunnerView[];
  exposures(): { runnerId: string; post: number }[];  // every mid-segment runner's target post
  settlePlay(): SettlementFact[];               // returns per-runner facts, removes home/out runners, parks survivors, clears per-play flags
  reset(): void;                                // innings switch / rematch: removes ALL runners
};
```

**Behaviour (from the design doc):**
- Shared command: `setDecision(go)` arms stop / resumes for every live runner simultaneously.
- **Forced on:** when a runner arrives at (or passes through) a post occupied by another runner, the occupant is immediately forced to run to the next post (auto-go overriding any armed stop). Cascades (three runners in a chain all shunt forward).
- Movement per runner at `moveSpeed(stats.speed, fatigueMult(stats.stamina))` exactly as M4; overshoot snaps to post.
- `highestPostThisPlay` updates on every post arrival/pass-through; home = post 4.
- `settlePlay()` parking: a mid-segment survivor settles at the PREVIOUS post (M4 safe-at-previous-post rule); at-post survivors stay. Two survivors must never settle on one post — if parking would collide, the trailing runner settles one post further back (document inline; construct the case in a test via forced-on timing).
- `markOut(id)`: freezes that runner (excluded from exposures, settles as out).

**Steps:**
- [ ] Failing tests first, covering: single-runner M4 parity (spawn, stop/go, pass-through, post-4 home — port the M4 cases to the list API); shared go/stop over 2 runners; forced-on at an occupied post + 3-runner cascade; per-runner exposures (two mid-segment runners expose two posts); markOut isolates one runner; settlePlay facts (ownHit flag only on the batter-runner, highestPost correct, home/out flagged), parking (mid-segment → previous post; collision → one further back), per-play flag reset (survivor's ownHitPlay false next play); reset() clears all.
- [ ] Implement; `npm run check` green; commit.

---

### Task 3: RulesModule (parallel-safe with 2, 4)

**Files:** create `server/src/modules/RulesModule.ts`, `server/test/RulesModule.test.ts`.

**Produces:**

```ts
export interface RulesConfig {
  squadA: Character[];          // batting order = array order
  squadB: Character[];
  inningsCount?: number;        // default CONST.GAME.INNINGS_COUNT; innings play A,B repeated this many times
}
export interface RulesView {
  phase: MatchPhase;
  battingSide: TeamSide;
  inningsIndex: number;         // 0-based over inningsCount*2 slots; tiebreak plays keep the last index
  scoreHalves: { A: number; B: number };
  outs: number;                 // batting side, this innings
  currentBatterId: string | null;
  tiebreak: boolean;
  winner: TeamSide | 'draw' | null;   // 'draw' never persists past resolve (tiebreak replaces it); null until GAME_OVER
}
export function createRulesModule(cfg: RulesConfig): {
  view(): RulesView;
  bothConnected(): boolean;       // LOBBY → DRAFT
  completeDraft(): boolean;       // DRAFT → INITIAL_POSITIONING (M5 stub — squads come from cfg)
  confirmPositioning(): boolean;  // INITIAL_POSITIONING → PRE_PLAY
  readyForPlay(): boolean;        // PRE_PLAY → PLAY
  resolvePlay(cause: PlayOutcome, facts: SettlementFact[]): PlayResolution | null;  // PLAY → PLAY_RESOLVE → (PRE_PLAY | INNINGS_SWITCH → PRE_PLAY | GAME_OVER)
  rematch(): boolean;             // GAME_OVER → INITIAL_POSITIONING (full reset except squads)
  isFinalInnings(): boolean;      // last A/B pair OR any tiebreak play
  pressure(runnersOnPosts: number): boolean;  // isFinalInnings() OR runnersOnPosts >= 2
};
```

All transition methods return `false` (and change nothing) when called out of phase — the room turns `false` into a rejection event. `resolvePlay` returns `null` out of phase.

**Behaviour:**
- Scoring per Global Constraints. `outs` = players out this innings; out players leave the batting queue for the rest of the innings; home runners rejoin the back of the queue.
- `resolvePlay` internals: apply `cause` outs (caught → batterId; runOut → runnerId) plus any facts flagged out; bank halves from facts (home+ownHit → 2; !home+ownHit+highestPost≥2 → 1); pick next batter from the queue; decide next phase: queue non-empty → PRE_PLAY; queue empty or all out → INNINGS_SWITCH (which itself immediately resolves to PRE_PLAY with sides swapped, or GAME_OVER after the last innings). PLAY_RESOLVE and INNINGS_SWITCH are therefore transient phases the view exposes momentarily (room broadcasts them) but the module leaves synchronously — document inline.
- Tie after the last innings → `tiebreak = true`, sudden-death pairs: sides alternate one play each starting with A; after each even-numbered tiebreak play, if scores differ → GAME_OVER with winner; else continue.
- `rematch()` zeroes score/outs/queues/tiebreak/winner, phase → INITIAL_POSITIONING (spec §2.8).

**Steps:**
- [ ] Failing tests first: happy-path phase walk LOBBY→…→GAME_OVER→rematch→INITIAL_POSITIONING; every transition method returns false out of phase (full matrix); scoring table (own-hit home = 2; own-hit post 2 and post 3 = 1; later-play completion = 0; caught = 0 + batter out; runOut = runner out); batting queue cycling (home runner bats again; out player skipped); innings ends on all-out AND on empty queue with a stranded runner (scores 0); A,B,A,B order and side swap; isFinalInnings across all innings + tiebreak; tie → alternating tiebreak plays → first differential pair wins; pressure() truth table (final innings, 0/1/2 runners).
- [ ] Implement; `npm run check` green; commit.

---

### Task 4: pressureMult wiring (parallel-safe with 2, 3)

**Files:** modify `server/src/modules/HitModule.ts`, `server/src/modules/FieldingModule.ts`, their test files.

**Interfaces:**
- Consumes: `pressureMult(nerve)` from `@carlquest/shared` formulas (exists since M3).
- Produces: `resolveSwing(...)` gains an optional final param `pressure = false`; when true, `timingFactor` is multiplied by `pressureMult(batter.stats.nerve)` before exit velocity. `FieldingDeps` gains `pressure?: () => boolean` (default `() => false`); when true at roll time, `pCatch` is multiplied by `pressureMult(fielder.stats.nerve)`.

**Steps:**
- [ ] Failing tests: HitModule — same swing with pressure=true yields exit velocity scaled by exactly `pressureMult(nerve)` (pin nerve 8 → ×0.97 and nerve 2 → ×0.88 via the shared formula, computed not hard-coded); FieldingModule — with a scripted rng chosen between the base and pressured pCatch, pressure flips a catch to a miss (deterministic seam test).
- [ ] Implement (multiplication at the single roll/timing site each); all existing hit/fielding tests stay green (default no-pressure paths unchanged); `npm run check`; commit.

---

### Task 5: MatchRoom + MatchState — the real phase machine

**Files:** modify `server/src/rooms/MatchState.ts`, `server/src/rooms/MatchRoom.ts`, `server/test/MatchRoom.test.ts`.

**Consumes:** Tasks 1–4 interfaces exactly as written above.

**Schema additions (MatchState):** `scoreHalvesA/scoreHalvesB: number`, `inningsIndex: number`, `outs: number`, `battingSide: string`, `currentBatterId: string`, `currentPitcherId: string`, `tiebreak: boolean`, `winner: string` ('' until set), `runners: MapSchema<RunnerSchema>` (replaces the single `runner`; RunnerSchema unchanged per-entry). `lastOutcome` now carries the JSON `PlayResolution` (was bare PlayOutcome).

**Room changes:**
- Construct `createRulesModule` with mirror-roster demo squads (both sides = full CHARACTERS table, batting order = table order — logged decision). Pitcher = fielding side's slot-0 character.
- Phase flow: `onJoin` (first client) → `bothConnected()` + `completeDraft()` immediately (M5 single-player stubs, logged); `confirmPositioning` message → gate to PRE_PLAY; `readyForPlay` → PLAY (pitch allowed); play outcome → `running.settlePlay()` → `rules.resolvePlay(cause, facts)` → broadcast `playOutcome` with the PlayResolution, sync schema, next phase per rules; `rematch` message at GAME_OVER.
- **Message validation matrix (spec §7):** `pitch`/`swing`/`runDecision` PLAY-only; `readyForPlay` PRE_PLAY-only; `confirmPositioning` INITIAL_POSITIONING-only; `rematch` GAME_OVER-only. All others rejected. Replace `demoLog` with a structured broadcast `rejected { message: string; phase: MatchPhase; reason: string }` AND keep a schema counter or last-rejection field only if a test needs polling — prefer asserting on the broadcast.
- **Per-runner run-out:** exposures = `running.exposures()`; the M4 detection (exposure-window-scoped `wasBallAtPost` snapshot + `isBallAtPost` + holder-at-post) generalises: track `lastExposures` as a `post→runnerId` map; clear post-crossing latches when the exposure SET changes (same guard discipline as M4 — the snapshot honoured only while the set is unchanged since the last check AND across the tick; do NOT weaken either condition, see CLAUDE.md §6.4); first detected run-out ends the play with that runnerId.
- Batter for each play = `rules.view().currentBatterId`'s character (stats drive HitModule); `running.startRun(batter)` on contact as M4. Pressure: `rules.pressure(countOfRunnersOnPosts)` feeds HitModule's param and FieldingModule's dep.
- **Test migration:** the M3/M4 room tests assume the LOBBY demo loop. Rewrite them onto the phase machine: a `startPlay(room, client)` helper walks confirmPositioning→readyForPlay; pitch/swing/outcome tests then run inside PLAY. Preserve every regression class (payload-less messages, garbage join options, throw pipeline, stale-crossing variants) — they must all still pass in the new phase context.

**Steps:**
- [ ] Failing integration tests first: phase walk over real Colyseus (join → INITIAL_POSITIONING after stubs; confirm → PRE_PLAY; ready → PLAY; outcome → PRE_PLAY with updated score/outs); out-of-phase rejection for EVERY message type (pitch in PRE_PLAY, ready in PLAY, rematch in PLAY, confirm in PRE_PLAY, payload-less everything — asserting the structured `rejected` broadcast); a scored rounder increments scoreHalves by 2 and the batter rejoins the queue; a caught batter increments outs; multi-runner schema (two runners visible after two plays where the first parked safe); full headless game to GAME_OVER (drive plays until both innings complete; assert winner set); rematch → INITIAL_POSITIONING with zeroed score.
- [ ] Implement; migrate existing tests; `npm run check` green (all suites); 10× MatchRoom stability loop 10/10; commit.

---

### Task 6: Client — phase/score status line, Enter/N keys, runner map

**Files:** modify `client/src/{NetModule,RenderModule,InputModule,main}.ts`.

- NetModule: expose new schema fields + `rejected`/`playOutcome` (PlayResolution) broadcasts.
- InputModule: **Enter** → sends `confirmPositioning` when phase is INITIAL_POSITIONING, `readyForPlay` when PRE_PLAY; **N** → `rematch` when GAME_OVER (read phase from state; no client-side rule logic beyond choosing which message to send).
- RenderModule: runner mesh becomes a per-id map with add/remove reconciliation (mirror the fielder pattern from M4).
- main.ts status line: `phase | A x½ – B y½ | innings i | outs o | batter: name` + last PlayResolution summary. No styled UI (M10).
- [ ] Implement (render-only, no client tests — M1/M3/M4 parity); `npm run check` green; commit.

---

### Task 7: Verification, acceptance, docs

- [ ] `npm run check` — record exact counts (expect ≈ 230+; all workspaces).
- [ ] Acceptance (§9.5) over a REAL server (scripted colyseus.js WS client, M3/M4 pattern): play a complete single-player game — both innings, at least one rounder, one half-rounder, one caught out, one run-out, innings switches, final score, GAME_OVER — logging every phase transition and PlayResolution received. If a tie occurs naturally, log the tiebreak; otherwise force one with a seeded second run (deterministic seed) to demonstrate sudden-death pairs.
- [ ] Browser demo: `npm run dev`; verify by code + served page if headless capture is still broken (per §6.4); note what was verifiable.
- [ ] CLAUDE.md §6: Current State, any new decisions, changelog entry, Known Issues (structured `rejected` replaces demoLog — REMOVE the stale §6.4 demoLog item; note single-confirmation stubs superseded in M6/M7).
- [ ] TUNING.md: add any new first-guess values introduced (expected: none — flag if a task added one).
- [ ] Conventional commits per task; no push (user pushes manually).

## Self-Review Notes

- Task 1 keeps the workspace compiling by patching the two M4 outcome-construction sites — later tasks never see a broken baseline.
- Tasks 2/3/4 are genuinely disjoint (RunningModule / RulesModule / Hit+Fielding) and only consume Task 1 — safe to dispatch in parallel.
- The forced-on parking-collision rule (settle one post further back) is an invented micro-rule the spec cannot answer; it is the minimal deterministic resolution and is logged for the user in §6.2 during Task 7.
- The PLAY_RESOLVE/INNINGS_SWITCH transient-phase treatment (synchronous pass-through, broadcast but not waited in) satisfies §2's ordering without adding timers; M6 may stretch them into real timed phases for presentation.
- `runnersOnPosts` for pressure() counts runners with `atPost !== null && atPost >= 1` (posts, not the batting square) — pin in a test.
