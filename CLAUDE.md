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

- **Milestone:** 3 (Pitch/Hit single-player loop) — COMPLETE: final review found 1 Critical (payload-less message crashed the process), fixed + regression-tested pre-merge; merged to main, tagged `m3-pitch-hit`. (M1 = `m1-scaffold`, M2 = `m2-physics`.) Next: Milestone 4 (FieldingModule + RunningModule) — revisit the accumulator-reset and world-time §6.2/§6.4 items when fielder bodies join the physics world.
- **Modules implemented:** `/shared` (types incl. StatBlock/AbilityId/Character/PitchInput/SwingInput; deep-frozen CONST; **formulas.ts** — ALL §5 formulas as tested pure functions; **characters.ts** — §3 roster, sole data source); `/server` (PhysicsModule (M2); **PitchModule.resolvePitch**; **HitModule.resolveSwing** (miss when |err| ≥ window); **MatchRoom demo loop** — 60 Hz `setSimulationInterval` with dt clamped to SIM_MAX_CATCHUP, synced BallSchema + ballLive + demoLog, `pitch`/`swing` handlers with idle/live + finite-number validation, server-authoritative timing via batting-plane crossing, demo cast Kian/Carl); `/client` (SceneModule + **NetModule** (colyseus.js join), **RenderModule** (ball view), **InputModule** (A/S/D spin, P pitch, Space swing), status line). No fielding/running/rules yet.
- **Test status:** 116/116 passing (72 shared; 44 server: 16 physics + 9 pitch + 10 hit + 9 room incl. payload-less rejection regressions); `npm run check` green — re-verified on merged main (44a1db9 = tag `m3-pitch-hit`). Acceptance demonstrated: scripted WS client — pitch curved (Magnus), swing timing factor 0.99, exit 33.3 m/s (= 34 × 0.99 per §5); per-frame canvas scan proved the ball renders in-browser (35 frames, 11→62 px along authoritative trajectory).
- **Open worktrees/branches:** none — milestone worktree and branch removed after merge. Local tags m1/m2/m3 not yet pushed (user pushes manually).

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

### 6.3 Changelog (append-only, newest first)

Entry format:

```
### YYYY-MM-DD — [Milestone N] Task title
- Changed: files/modules touched
- Verified: exact command(s) run + result (e.g. `npm run check` → 0 errors, 42 tests passed)
- Notes/deviations: anything the spec didn't cover, or "none"
```

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
- `isBallAtPost` is a discrete end-of-substep poll of Rapier's intersection graph: a very fast grazing pass can cross a sensor between poses and never register. Fine for M4 run-outs as designed (ball is delivered TO the post and stays/bounces); if fly-through detection is ever needed, switch to Rapier collision events (EventQueue) rather than widening the sensor.
- MatchRoom's `demoLog` is a stringly-typed placeholder (tests match on 'rejected' substrings) — replace with structured play-outcome events in M5 (spec §7 `playOutcome`).
- Swing-vs-plane-crossing same-tick ordering gives up to one tick (~16.7 ms) of timing ambiguity, and the pre-crossing projection is linear (ignores remaining Magnus/gravity curvature) — same error class; fold both into M6 latency work.
- Contact has no lateral/height proximity requirement — a swing "connects" wherever the ball crosses the z-plane (spec §5 defines contact purely by timing). Revisit with Fielding/Rules (M4/M5).
- No per-client role gating in M3: either joined client may pitch and swing; phase validation approximated by the ballLive gate while phase = LOBBY. Superseded by M5 state machine + M6/M7 roles.
- Huge-but-finite aim components (~1e308) overflow normalisation to a zero-velocity pitch/hit (self-inflicted only, no NaN); pre-scale by max component if it ever matters.
- Tuning note (TUNING candidate): a max-power 60°-elevation hit flies ~6.0 s vs PLAY_TIMEOUT_S = 6 — the ball can be despawned mid-air at the extreme.
- The ball never sleeps: Magnus `resetForces`/`addForce` wakes it every substep even at rest. Harmless at one body / 60 Hz; skip near-zero forces if it ever matters.
