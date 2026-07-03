# CLAUDE.md — Carl Quest Sports

Multiplayer (2-player) 3D rounders game. TypeScript strict, Three.js, Rapier physics, Colyseus authoritative server, Vite. Monorepo: `/client`, `/server`, `/shared`. The design spec at `docs/design/spec.md` is the single source of intent — implement it exactly as written.

## 1. NON-NEGOTIABLES

- **Use the `superpowers` plugin.** Its skills define the workflow below; invoke the named skill at each stage. Do not freelance around it.
- **Plan before executing. Always.** No code, no file edits, no refactors without a written plan first (see §2, steps 1–2). Trivial one-line fixes still get a one-paragraph plan stating the change and how it will be verified.
- **Use sub-agents for implementation whenever possible.** Delegate independent tasks to sub-agents rather than doing everything in the main session; parallelise independent work (see §2, step 4).
- **Server is authoritative.** All game logic and physics live in `/server`; the client only renders and predicts. Every network message is phase-validated server-side.
- **All tunables in `/shared/constants.ts`; all stat formulas as pure functions in `/shared/formulas.ts`.** No magic numbers elsewhere. `characters.ts` is the only roster data source.
- Fixed 1/60 s deterministic server physics step. British English throughout.
- **Use the `unslop-ui` skill when designing any UI element** (lobby, draft screen, positioning panel, HUD, result screen). Make a deliberate, project-specific design choice rather than shipping templated defaults or an AI-generated look.
- **Maintain the Project Log (§6) in this file.** After every completed task, and before ending any session, WRITE what was done to §6. At the start of every session, READ §6 before doing anything else and treat it — not your memory of prior sessions — as the ground truth of project state. If §6 and your assumptions disagree, §6 wins; if §6 and the actual code disagree, inspect the code, then correct §6.

## 2. THE WORKFLOW, SKILL BY SKILL

Follow this lifecycle for every feature, fix, or change. Each named skill is invoked at its stage.

1. **Brainstorm first (`brainstorming`).** Before ANY creative or implementation work, on any new feature or behaviour change, use `brainstorming` to explore intent, requirements and design. For this project the design documents in `/docs/design/` are the primary intent source; use brainstorming to reconcile the spec with the existing code and surface unknowns (ambiguous rules, untuned constants, missing acceptance criteria) before writing anything. Never jump straight to code.

2. **Write a plan (`writing-plans`).** Once the design is clear, use `writing-plans` to produce a written implementation plan before touching code. Every non-trivial module or milestone gets a plan: files to create/change, interfaces, tests to write first, and the verification command that proves it done.

3. **Isolate the work (`using-git-worktrees`).** Before executing a plan or starting feature work that needs isolation, use `using-git-worktrees` so the work happens in a clean, separate workspace. One worktree per milestone or major module.

4. **Execute with TDD and sub-agents.**
   - Use **`test-driven-development`** when implementing any feature or bugfix: write the test/verification first, then the implementation. For this project that means defining the failing Vitest case first — the formula output, the state-machine transition, the validation rejection, the ability modifier, the physics deviation (tolerance-based) — before writing the module, then building until it passes.
   - Use **`subagent-driven-development`** to execute the plan's independent tasks in the current session, and **`dispatching-parallel-agents`** whenever there are 2+ independent tasks with no shared state or sequential dependency. Default to parallelising: one agent per independent module (PhysicsModule, PitchModule, HitModule, FieldingModule, RunningModule, RulesModule, PositioningModule, DraftModule), a dedicated client/UI agent, a dedicated test agent. The `/shared` contracts (types, constants, formulas) must land first, then the server modules are largely independent and well suited to heavy parallel dispatch.
   - Use **`executing-plans`** when running a written plan across review checkpoints.

5. **Debug systematically (`systematic-debugging`).** On ANY bug, test failure, or unexpected behaviour — including desyncs between client render and server state, physics non-determinism, or Colyseus schema patch errors — use `systematic-debugging` BEFORE proposing a fix. No guess-and-check patching. Reproduce with a minimal deterministic test (fixed seed, fixed timestep), diagnose the actual cause from logs/state dumps, then fix the root, not the symptom.

6. **Verify before claiming done (`verification-before-completion`).** Before you call anything complete, fixed, or passing, before any commit or merge, use `verification-before-completion`: run the actual verification and confirm the output. Evidence before assertions, always. "It should work" and "it compiles" are not completion. For this project, completion means: `npm run check` (typecheck + lint + Vitest) passes clean across all workspaces; the milestone's acceptance behaviour was demonstrated in a real run (two clients over Colyseus for networked features); out-of-phase and illegal messages are shown to be rejected server-side for any networking/validation change; and no `any`/`@ts-ignore` was introduced without a justifying comment. Once verified, immediately record the result in the Project Log (§6) — verification without a log entry is incomplete.

7. **Request review (`requesting-code-review`).** On completing a major feature or before merging, use `requesting-code-review` to verify the work meets requirements. If you receive review feedback, use **`receiving-code-review`**: verify each point with technical rigour rather than performative agreement or blind implementation; push back where a suggestion is wrong, confirm where it is right.

8. **Finish the branch (`finishing-a-development-branch`).** When implementation is complete and all verification passes, use `finishing-a-development-branch` to decide integration (merge, PR, or cleanup) properly rather than leaving work dangling.

## 3. PROJECT COMMANDS

- `npm run dev` — client (Vite) + server (Colyseus) in watch mode.
- `npm run check` — typecheck + lint + test, all workspaces. Must be green before any commit.
- `npm run test` — Vitest.
- `npm run build` — production build of client and server.

## 4. ORDER OF WORK

Follow the milestone order in `docs/design/spec.md` §9 strictly; each milestone must be runnable, verified, and committed (tagged) before the next begins. Within a milestone, land `/shared` contracts before dispatching parallel server-module agents.

## 5. WHEN THE SPEC IS SILENT

Use the defaults in spec §8b without asking. For anything else genuinely ambiguous, surface it during `brainstorming` and ask the user — do not invent rules of rounders or retune constants unprompted. Tuning suggestions go in a `TUNING.md` note, not into code.

## 6. PROJECT LOG — LIVE STATE (Claude Code MUST maintain this)

This section is the anti-hallucination ledger. It is the **only** trusted record of what exists, what works, and what was decided. Never claim a module, test, file, or feature exists unless it is recorded here or you have just verified it in the actual codebase. Never rely on memory of previous sessions.

**Rules:**
- **Write, don't summarise from memory.** Update this section immediately after each completed task — not at the end of a long batch. Sub-agents report back; the main session records their results here after verifying them.
- **Only log verified facts.** An entry may only say "done/passing" if `verification-before-completion` was run and the command output confirmed it. Log the command used.
- **Log decisions and deviations.** Any interpretation of an ambiguous spec point, any deviation from the spec (with user approval noted), any constant tuned away from its §6 suggested value.
- **Log known issues honestly.** Failing tests, flaky behaviour, TODOs, and anything skipped go in Known Issues — never silently drop them.
- **Keep entries terse and factual.** Date, milestone/task, files touched, verification evidence. No prose padding.
- Update **Current State** (overwrite in place) and append to **Changelog** (never rewrite history).

### 6.1 Current State (overwrite to reflect reality)

- **Milestone:** 4 (Fielding + Running) — Tasks 5–7 of 7 COMPLETE on branch `worktree-m4-fielding-running`, pending final review + merge + m4 tag. Tasks 1–4 previously merged to main (97eb82c, via git bundle). Task 5 = MatchRoom fielding/running wiring (schema, runDecision, event-accurate run-out, outcome resolution); Task 6 = client fielders/runner rendering + R/T run keys + outcome status; Task 7 = full verification + §9.4 acceptance + TUNING.md + this log. Plan: `docs/superpowers/plans/2026-07-03-milestone-4-fielding-running.md`. (M1 = `m1-scaffold`, M2 = `m2-physics`, M3 = `m3-pitch-hit`.)
- **Modules implemented:** `/shared` (types incl. StatBlock/AbilityId/Character/PitchInput/SwingInput + **RunDecisionInput/PlayOutcome/FielderSetup**; deep-frozen CONST incl. M4 fielding tunables + FIELDING_POSITIONS; **formulas.ts** — ALL §5 formulas + **approachPenalty**; **characters.ts** — §3 roster; **rng.ts** — mulberry32 `createRng`); `/server` (PhysicsModule (M2 + **hasBounced()** via Rapier EventQueue + **setBlocker/clearBlocker** capsule API + **wasBallAtPost/isBallAtPost/clearPostCrossings**); PitchModule; HitModule; **FieldingModule** — chaser+cover pursuit, entry-latched pCatch roll, caught-vs-gathered, ballistic throw solve, sprint/throw stamina drain; **RunningModule** — post-to-post runner, stop/go, pass-through, post-4 = rounder, `exposedPost()`; **MatchRoom — FULLY wired**: 9-fielder MapSchema + runner schema, `runDecision` handler, event-accurate exposure-scoped run-out, first-outcome-wins resolution (caught→runOut→rounder→safe), `playOutcome` broadcast + JSON `lastOutcome`, `{seed?, rng?}` test-hook options); `/client` (SceneModule + NetModule (+runDecision/playOutcome) + RenderModule — **ball + fielder capsules + runner capsule** + InputModule (**R go / T stop** keys) + main.ts status line shows outcomes). No rules engine yet (M5).
- **Test status:** 187/187 passing (86 shared: 4 rng + 15 formulas + 52 constants + 15 characters; 101 server: 29 physics + 9 pitch + 10 hit + 22 fielding + 15 running + 16 room); `npm run check` green on `worktree-m4-fielding-running` — typecheck ×3 clean, ESLint clean, `npm run test` 10 files / 187 tests. **M4 §9.4 acceptance run (Task 7):** scripted colyseus.js WS client vs a real `npm run dev` server (ws://localhost:2567) captured all three outcomes as live `playOutcome` broadcasts — (a) seed 5 flat hit at post 1, runner running → `{"kind":"runOut","atPost":1}`; (b) **same seed 5**, lofted mid-field hit + `runDecision{go:false}` → `{"kind":"safe","atPost":1}`; (c) seed 1 flat hit at the bowler → `{"kind":"caught","by":"kian"}` (pre-bounce). Vite served 200 on 5173, Colyseus on 2567. Evidence: `.superpowers/sdd/acceptance.mjs` + `acceptance-output.log`, `task-7-report.md`.
- **Open worktrees/branches:** `worktree-m4-fielding-running` (this branch, 4 commits ahead of main: task-5 wiring + 2 run-out fixes + task-6 client). Tasks 1–4 on main at 97eb82c. Local tags m1/m2/m3 not yet pushed (user pushes manually). No m4 tag yet (awaits merge).

### 6.2 Decisions Record (append-only)

| Date | Decision | Reason |
|------|----------|--------|
| 2026-07-03 | npm workspaces (not pnpm) | Matches `npm run …` commands mandated in §3; stated in README. |
| 2026-07-03 | Field geometry (post/square coordinates in CONST.FIELD) is a placeholder school-rounders layout | Spec gives no pitch dimensions; structural tests only pin 4 posts + positive dimensions; tune in playtest. |
| 2026-07-03 | `BENCH_STAMINA_REGEN = 1` per play | Spec §4 names the constant but gives no value; revisit when fatigue lands (Milestone 4). |
| 2026-07-03 | typescript-eslint v8 (plan said v7) | v7 requires ESLint 8; repo uses ESLint 9. |
| 2026-07-03 | Server tsconfig keeps base Bundler/ESNext resolution (plan said NodeNext override) | NodeNext broke extensionless source-level `@carlquest/shared` imports and `@colyseus/tools` CJS interop under tsx. |
| 2026-07-03 | `server/src/app.config.ts` exports a typed plain `ConfigOptions` object rather than calling `@colyseus/tools` `config()` | The default-import `config()` call crashes under real Node ESM (CJS interop); invariant kept: one config shared by index.ts and @colyseus/testing. |
| 2026-07-03 | `server/vitest.config.ts` pins `pool: 'threads'` | Vitest 2.1.9 forks pool crashes on Windows IPC. |
| 2026-07-03 | M2 new tunables: `BALL_RELEASE_HEIGHT = 1.0`, `GROUND_THICKNESS = 0.1`, `POST_SENSOR_RADIUS = 0.5` | Spec §6 silent on these; needed for spawn default, cuboid ground, run-out sensors. |
| 2026-07-03 | Whale `WALL` blocker collider deferred to Milestone 4 | Spec §6 says "active during fielding"; FieldingModule doesn't exist until M4. |
| 2026-07-03 | Ball collider uses `CoefficientCombineRule.Max` for restitution | Rapier default Average blends ball 0.4 with unset ground 0 → effective 0.2; Max makes the spec's 0.4 the effective coefficient. |
| 2026-07-03 | `@dimforge/rapier3d-compat` pinned at ^0.14.0 | First Rapier usage; version recorded for determinism (same binary ⇒ same trajectories). |
| 2026-07-03 | `placeBall` resets the step accumulator (pitch re-anchors substep phase) | Makes pitch trajectories independent of message arrival within a frame. The accumulator is WORLD time — MUST be revisited in M4 when fielder bodies join the world (final-review finding). |
| 2026-07-03 | Hit launch direction from the batter's aim vector, elevation clamped −10°..60° | Spec §1 names launch angle but §5 gives no formula; USER-APPROVED choice (aim-based) over timing-derived alternatives. |
| 2026-07-03 | M3 new tunables: HIT_ELEVATION_MIN/MAX_DEG −10/60, PITCH_ELEVATION_MAX_DEG 20, PLAY_TIMEOUT_S 6, BALL_REST_SPEED 0.1, BALL_REST_TIME_S 1, SIM_MAX_CATCHUP 0.25 | Spec silent; needed for aim clamps, demo play-end and the tick clamp. |
| 2026-07-03 | Client `swing.timing` field accepted but IGNORED in M3; server sim-time (batting-plane crossing) is authoritative | Server-authoritative principle; latency compensation revisited in M6 networking. |
| 2026-07-03 | Pitch/hit spin input = scalar in [−1,1] mapped to vertical-axis sidespin | §7 gives `spinInput` without semantics; sidespin is what Magnus turns into visible curve. |
| 2026-07-03 | Demo cast fixed: pitcher Kian, batter Carl | M3 single-player loop needs stats before the draft exists (M7). |
| 2026-07-03 | Degenerate aim vectors (zero, non-finite, purely vertical) fall back to sane defaults instead of throwing | Player input must never crash the room or inject NaN into physics (review finding, fixed in both modules). |
| 2026-07-03 | M4 Tasks 1–4 implemented in an external Claude session, delivered as `carlquest3m4.bundle`, verified locally (`npm run check` 175/175) before fast-forward merge | User-directed workflow for this batch. |
| 2026-07-03 | `RunDecisionInput` message shape added to §7 contracts | USER-APPROVED deviation (per bundle commit 5823b2c); spec §7 lacked a run stop/go message. |
| 2026-07-03 | Fielders are kinematic (module-computed positions), NOT Rapier bodies; ball remains the world's only dynamic body | Closes the M2 `placeBall` accumulator-reset caveat by design (no other body loses world time). WALL blocker capsule API exists but activation lands in M9. |
| 2026-07-03 | M4 new tunables: APPROACH_W 0.35, APPROACH_REF_SPEED 30, THROW_RELEASE_DELAY_S 0.5, SPRINT_STAMINA_COST_PER_S 0.15, THROW_STAMINA_COST 0.5, CATCH_HEIGHT_MAX 2.5; FIELDING_POSITIONS 9-slot placeholder layout (slot 0 = bowling square) | Spec silent; needed for catch rolls, throws, fatigue. Real positioning UI lands M8. |
| 2026-07-03 | Deterministic catch rolls via seeded mulberry32 `createRng` in `/shared/rng.ts` | Server-authoritative determinism; one pCatch roll per catch-radius entry (entry-latched). |
| 2026-07-03 | Fielding ability hooks left as neutral defaults | Abilities (QUICK_DRAW etc.) wire in at M9 per plan. |
| 2026-07-03 | Run-out detection is event-accurate: `PhysicsModule.wasBallAtPost(n)` latches Rapier `EventQueue` sensor-intersection events per substep (post sensors gain `ActiveEvents.COLLISION_EVENTS`), reset on spawn/pitch/hit; `MatchRoom.checkRunOut` uses it (dropped the `sweptPost` proximity heuristic) | Task-5 review Important 1/2: fixes the §6.4 once-per-tick-poll fly-through gap the documented way (events, not a widened capture volume), removing the detection-side test flake. Residual retry is ONLY on the catch test — absorbs which-fielder-is-nearest jitter from sub-tick swing-message landing (`waitForNextSimulationTick` is a fixed timer), never detection; run-out is single-attempt (10×/10 stable). |
| 2026-07-03 | Run-out crossings are scoped to the runner's exposure window: MatchRoom tracks `exposedPost()` transitions and calls new `PhysicsModule.clearPostCrossings()` on any change (window opens clean at the hit); `checkRunOut` = `wasBallAtPost` (during-exposure crossing) OR `isBallAtPost` (ball already resting inside the sensor — entry events don't re-fire) OR holder-at-post | Task-5 fix round 2: a segment-lifetime latch was a reachable false run-out (hit flies through post 2 early, runner later sets off for post 2 → stale crossing ran them out). Rule is "ball at the exposed post WHILE exposed". Regression-tested at both layers. All test retries now removed — catch test is single-attempt asserting `kind === 'caught'` (who catches is nearest-fielder jitter, deliberately unpinned). 10×/10 stable. |
| 2026-07-03 | Demo fielding side (M4): the first 9 roster entries *excluding the demo batter Carl*, in table order, mapped onto `FIELDING_POSITIONS` in slot order → Kian lands on slot 0 (the bowler), Laurie backstop, then posts and deep field | The M3 demo cast fixes only pitcher/batter; the fielding nine needs a deterministic source before the M7 draft. Table-order-minus-batter is the simplest stable choice; positioning is refined in M8. The integration test derives `FIELDING_IDS` the same way so it cannot drift. |
| 2026-07-03 | Play-end while the runner is mid-segment (rest/timeout, not run out) resolves as `safe` at the *previous* post: `runner.atPost ?? (targetPost !== null ? targetPost − 1 : 0)` | Spec §8 has no partial-advance credit; a runner caught between posts at play end is safe where they last stood, not at the post they were heading to. RunningModule guarantees a live non-home runner always has one of atPost/targetPost non-null, so the `: 0` arm is unreachable defensive default (documented inline in `resolveOutcome`). |
| 2026-07-03 | Fielding rng seed source: `MatchRoom.onCreate` uses `options.seed ?? Date.now()` → `createRng(seed)`; `options.rng` (a function) overrides it entirely | `options.seed`/`options.rng` are TEST-ONLY deterministic injection points — a function cannot cross the WS wire, so live clients always fall through to `Date.now()`, the one permissible wall-clock read (it seeds fielding randomness, NOT the deterministic physics step). Unit tests pass `rng: ALWAYS_CATCH/ALWAYS_MISS`; the Task-7 WS acceptance passes a numeric `seed` and searches a small range to exhibit each §9.4 outcome (legitimate demonstration, not the "no magic seed hunting" the module tests avoid). |

### 6.3 Changelog (append-only, newest first)

Entry format:

```
### YYYY-MM-DD — [Milestone N] Task title
- Changed: files/modules touched
- Verified: exact command(s) run + result (e.g. `npm run check` → 0 errors, 42 tests passed)
- Notes/deviations: anything the spec didn't cover, or "none"
```

### 2026-07-03 — [Milestone 4] MatchRoom wiring, client rendering, acceptance (Tasks 5–7)
- Changed: server/src/rooms/{MatchRoom,MatchState}.ts (fielding/running wiring, FielderSchema/RunnerSchema, runDecision, event-accurate exposure-scoped run-out, outcome resolution + playOutcome broadcast, `{seed?,rng?}` options), server/src/modules/PhysicsModule.ts (wasBallAtPost/isBallAtPost/clearPostCrossings via post-sensor COLLISION_EVENTS) + PhysicsModule/MatchRoom tests; client/src/{RenderModule,NetModule,InputModule,main}.ts (fielder + runner capsules, R/T run keys, playOutcome status line); TUNING.md (new, repo root); CLAUDE.md §6. Commits a1cd756, 8b2049b, 99bbb8a (run-out fixes), 7377153 (client).
- Verified: `npm run check` on `worktree-m4-fielding-running` → typecheck ×3 clean, ESLint clean, `npm run test` 10 files / 187 passed (86 shared, 101 server). §9.4 acceptance over a REAL Colyseus server (scripted colyseus.js WS client vs `npm run dev` on ws://localhost:2567), all three outcomes captured as live `playOutcome` broadcasts: (a) seed 5 flat hit @post1, running → `{"kind":"runOut","atPost":1}`; (b) SAME seed 5, lofted mid-field hit + `runDecision{go:false}` → `{"kind":"safe","atPost":1}`; (c) seed 1 flat hit @bowler → `{"kind":"caught","by":"kian"}`. Vite 200 on 5173, Colyseus on 2567. Harness + logs: `.superpowers/sdd/acceptance.mjs`, `acceptance-output.log`, `task-7-report.md`.
- Notes/deviations: new §6.2 rows (demo fielding-side mapping; safe-at-previous-post; rng seed source). New §6.4 items (any-client runDecision; JSON-string lastOutcome; static runner stamina; one-tick exposure-transition simultaneity; headless-Edge screenshot could NOT be captured this session). Browser visual acceptance NOT captured: headless Edge exits code 13 (fails to launch headless) in this environment even for a trivial page — see §6.4; client rendering verified by code + served page instead. No src changes made in Task 7 (acceptance found no defect).

### 2026-07-03 — [Milestone 4] Fielding/Running server layer (Tasks 1–4, via bundle)
- Changed: shared/src/{types,constants,formulas,index}.ts, shared/src/rng.ts (new) + 3 test files; server/src/modules/PhysicsModule.ts (hasBounced via EventQueue, setBlocker/clearBlocker), server/src/modules/{FieldingModule,RunningModule}.ts (new) + tests; docs/superpowers/{plans,specs} M4 documents. Source: `carlquest3m4.bundle` (external Claude session), branch fast-forward-merged to main at 97eb82c.
- Verified: `npm run check` on the bundle branch pre-merge → typecheck ×3 clean, ESLint clean, 175/175 tests (10 files). `git bundle verify` OK; base commit = prior main head, so a pure fast-forward. `package-lock.json` churn from local `npm install` (libc metadata) discarded.
- Notes/deviations: Tasks 5–7 (MatchRoom wiring, client, acceptance) NOT included — milestone still open, no m4 tag. New §6.2 rows: RunDecisionInput, kinematic fielders, M4 tunables, seeded RNG, neutral ability hooks.

### 2026-07-03 — [Milestone 3] Pitch/Hit single-player loop (Tasks 1–6)
- Changed: shared/src/{formulas,characters}.ts (new) + types/constants/index + 3 test files; server/src/modules/{PitchModule,HitModule}.ts (new) + tests; server/src/rooms/{MatchState,MatchRoom}.ts (demo loop) + integration tests; client/src/{NetModule,RenderModule,InputModule}.ts (new), main.ts, index.html, package.json (+colyseus.js); eslint.config.js (ignore scratch dirs).
- Verified: `npm run check` → typecheck ×3 clean, ESLint clean, 112/112 tests. Acceptance (spec §9.3): scripted Colyseus client over real WS — pitch curved via Magnus (x −0.13 by the plane), swing at z=0.51 connected timing factor 0.99, exit 33.3 m/s = exitVelocity(8, 0.99) exactly; in-browser per-frame canvas scan proved the rendered ball tracks the authoritative trajectory (35 frames, 11→62 px). Server integration test proves the loop headlessly.
- Notes/deviations: see new §6.2 rows (aim-based launch user-approved; swing.timing ignored; sidespin mapping; demo cast; degenerate-aim guards). Review process caught a real NaN-injection bug (vertical aim) pre-merge; fixed TDD in both modules.

### 2026-07-03 — [Milestone 2] PhysicsModule (Tasks 1–5)
- Changed: shared/src/types.ts (+PitchParams/HitParams/BallState), shared/src/constants.ts (+3 tunables), shared/test/constants.test.ts (39 tests); server/package.json (+@dimforge/rapier3d-compat@0.14.0); server/src/modules/PhysicsModule.ts (new); server/test/PhysicsModule.test.ts (16 tests).
- Verified: `npm run check` → typecheck ×3 clean, ESLint clean, 57/57 tests. §9.2 acceptance: spun pitch deviates >0.1 m laterally vs spinless (which drifts <1e-6); opposite spin curves opposite; bounce apex ratio in (0.05, 0.4); damping bleeds speed and spin; determinism = exact float equality over 300 substeps between twin modules.
- Notes/deviations: restitution combine rule Max (see §6.2); `spawnBallAt` free function instead of `this.spawnBall` in the factory literal (strict-mode `this` typing); each task independently reviewed (all approved, 0 critical/important findings).

### 2026-07-03 — [Milestone 1] Monorepo scaffold (Tasks 1–5)
- Changed: root workspace (package.json, tsconfig.base.json, eslint.config.js, .prettierrc.json, vitest.workspace.ts, README.md, .gitignore); shared/ (package.json, tsconfig.json, src/{index,types,constants}.ts, test/constants.test.ts); server/ (package.json, tsconfig.json, vitest.config.ts, src/{index,app.config}.ts, src/rooms/{MatchRoom,MatchState}.ts, test/MatchRoom.test.ts); client/ (package.json, tsconfig.json, vite.config.ts, index.html, src/{main,SceneModule}.ts); .claude/launch.json; plan doc amendments.
- Verified: `npm run check` → typecheck clean ×3 workspaces, ESLint clean, 38/38 Vitest tests passed. `npm run dev` → Vite HTTP 200 on 5173 AND Colyseus listening on 2567 concurrently. Visual acceptance: headless-Edge screenshot of http://localhost:5173 shows ground, batting/bowling squares, 4 posts, sky. Server boot test joins a client and reads phase 'LOBBY' from synced schema.
- Notes/deviations: see Decisions Record 2026-07-03 rows (typescript-eslint v8, Bundler resolution kept, plain ConfigOptions export, vitest threads pool). Node.js 24 LTS was installed on this machine via winget (was absent). Executed via subagent-driven development; each task passed an independent spec+quality review.

### 6.4 Known Issues (keep current — remove only when fixed and verified)

- Server test stdout is not pristine: `@colyseus/tools` prints an ".env file not found" info line, and MatchRoom onJoin/onLeave console.logs (plan-mandated) appear in Vitest output. Cosmetic; revisit when MatchRoom gains real logic.
- `npm audit` reports 10 vulnerabilities (8 moderate, 1 high, 1 critical) as of 2026-07-03, triaged at M1 final review: critical = Vitest UI file-read/execute (UI never used, dev-only); high = Vite dev-server issues (localhost dev only); moderates = esbuild dev CORS + nanoid <3.3.8 in @colyseus/core (only runtime one; predictability condition doesn't apply to Colyseus usage). All fixes need breaking major bumps (Vite 7/8, Vitest 3, Colyseus 0.16+) — deferred deliberately; revisit at a natural upgrade point.
- Client `SceneModule.resize()` re-applies `setPixelRatio(window.devicePixelRatio)` per resize event — reviewed and kept (catches cross-monitor DPI changes; idempotent, cheap). Not a defect; noted so it isn't re-flagged.
- `server/package.json` `build` script aliases typecheck (no emit config yet); real build wiring deferred until a milestone needs emitted server JS.
- Client WebGL renders very slowly in the sandboxed preview browser (software rasteriser) — verification used headless Edge instead; real browsers are fine.
- `isBallAtPost` remains a discrete end-of-tick intersection poll, now used in run-out checks for the resting-inside-the-sensor case (entry events don't re-fire when an exposure window opens) plus instantaneous queries. Fly-through detection is `wasBallAtPost(n)`: per-substep `EventQueue` sensor-intersection latches (reset on spawn/pitch/hit AND cleared by MatchRoom on every `exposedPost()` change, so a crossing only counts while the runner is actually exposed to that post — Task-5 fix round 2), capturing an intra-tick fly-through the once-per-tick poll misses (Task-5 review Important 1). This is the "switch to EventQueue rather than widen the sensor" path this note previously flagged; the earlier `sweptPost` proximity heuristic in MatchRoom has been removed. Note: `wasBallAtPost` catches intra-tick crossings but NOT a crossing that skips every fixed substep pose (sensors get no CCD); that is irrelevant to M4 run-outs (balls are delivered TO posts at post-bounce/rolling speeds).
- MatchRoom's `demoLog` is a stringly-typed placeholder (tests match on 'rejected' substrings) — replace with structured play-outcome events in M5 (spec §7 `playOutcome`).
- Swing-vs-plane-crossing same-tick ordering gives up to one tick (~16.7 ms) of timing ambiguity, and the pre-crossing projection is linear (ignores remaining Magnus/gravity curvature) — same error class; fold both into M6 latency work.
- Contact has no lateral/height proximity requirement — a swing "connects" wherever the ball crosses the z-plane (spec §5 defines contact purely by timing). Revisit with Fielding/Rules (M4/M5).
- No per-client role gating in M3: either joined client may pitch and swing; phase validation approximated by the ballLive gate while phase = LOBBY. Superseded by M5 state machine + M6/M7 roles.
- Huge-but-finite aim components (~1e308) overflow normalisation to a zero-velocity pitch/hit (self-inflicted only, no NaN); pre-scale by max component if it ever matters.
- Tuning note (TUNING candidate): a max-power 60°-elevation hit flies ~6.0 s vs PLAY_TIMEOUT_S = 6 — the ball can be despawned mid-air at the extreme.
- The ball never sleeps: Magnus `resetForces`/`addForce` wakes it every substep even at rest. Harmless at one body / 60 Hz; skip near-zero forces if it ever matters.
- No per-client role gating on `runDecision` (M4): either joined client may send stop/go for the runner, exactly like pitch/swing in M3. Superseded by the M5 state machine + M6/M7 role assignment.
- `MatchState.lastOutcome` is a JSON-serialised `PlayOutcome` string (schema numbers can't be `null`, and a structured outcome schema wasn't worth it pre-Rules). Replace with a proper `@type` schema once RulesModule owns scoring in M5; tests currently `JSON.parse` it.
- Runner stamina is static within a play (M4): `RunningModule` fixes the runner's speed at `startRun` from full-stamina `fatigueMult`, and fielder sprint/throw stamina costs (though applied) don't feed back into the same play. Real intra-/inter-play fatigue lands with multi-play innings in M5.
- One-tick simultaneity at exposure transitions: if the ball crosses the exposed post's sensor and the runner arrives at that post in the same tick, `running.tick` changes exposure before `checkRunOut` reads the latch — the photo-finish resolves in the runner's favour. Same error class as the logged swing-vs-plane same-tick ambiguity; revisit with M5/M6 (state machine + latency work).
- Headless-Edge screenshot capture is NOT working in the current session environment: `msedge --headless=new --screenshot=…` exits code 13 (fatal launch failure) even for a trivial data-URI page, and the CDP `--remote-debugging-port` endpoint never binds. So the M4 browser visual acceptance (fielder/runner capsules rendered) could not be captured as a PNG this session — client rendering was instead verified by code review + the served page (Vite 200; server sends 9 fielders in the initial snapshot so capsules render on connect). Earlier milestones' note that "headless Edge is fine" no longer holds here (Edge/OS-policy change); revisit with a working headless browser. Keyboard injection into the browser remains infeasible regardless.
