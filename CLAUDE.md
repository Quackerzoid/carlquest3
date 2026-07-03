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

- **Milestone:** 0 — not started.
- **Last green commit:** none.
- **Modules implemented:** none.
- **Test status:** no test suite yet.
- **Open worktrees/branches:** none.

### 6.2 Decisions Record (append-only)

| Date | Decision | Reason |
|------|----------|--------|
| — | — | — |

### 6.3 Changelog (append-only, newest first)

Entry format:

```
### YYYY-MM-DD — [Milestone N] Task title
- Changed: files/modules touched
- Verified: exact command(s) run + result (e.g. `npm run check` → 0 errors, 42 tests passed)
- Notes/deviations: anything the spec didn't cover, or "none"
```

_(no entries yet)_

### 6.4 Known Issues (keep current — remove only when fixed and verified)

_(none recorded)_
