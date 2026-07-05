# Auto-Play Redesign + Presentation Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plays resolve automatically as visible dice-roll beats (players manage positioning/subs/batting order only); the field runs counter-clockwise; the batter is rendered and animated; pitcher throws visibly; clamped orbit camera; skybox; full angular esports UI restyle.

**Architecture:** A pure `AutoPlayModule` makes the beat decisions from the injected seeded rng; MatchRoom schedules beats on sim time and broadcasts `roll` events; the old play messages become tombstones. Client: batter view + throw/hit poses on the existing rigs, a `CameraControls` module, a skybox, and a restyled UI with a roll-flash banner.

**Tech Stack:** TypeScript strict, Colyseus, Rapier (untouched), Three.js, Vitest, Playwright.

**Design spec:** `docs/superpowers/specs/2026-07-05-autoplay-redesign-design.md` — read before any task. This is a user-directed redesign superseding spec §7's player play-messages.

## Global Constraints

- Formulas, abilities, physics, scoring, rules: UNTOUCHED. The dice are the existing maths; AutoPlay only chooses inputs and samples timing errors.
- All new tunables in `shared/src/constants.ts` `GAME` block, exact values: `AUTOPLAY_PITCH_DELAY_S: 1.0`, `AUTOPLAY_BEAT_MIN_GAP_S: 0.6`, `AUTOPLAY_TIMING_NOISE_S: 0.3`, `AUTOPLAY_RUN_BASE: 0.3`, `AUTOPLAY_RUN_NERVE_W: 0.3`, `AUTOPLAY_RUN_HELD_RISK: 0.15`, `AUTOPLAY_RUN_DIST_REF: 30`.
- Rejection prose for the tombstoned messages is EXACT: `'plays resolve automatically'`.
- All rolls through the room's injected rng (seeded) — deterministic; no Date.now/Math.random server-side.
- Beat scheduling on SIM time (pause-safe; the paused tick freeze must freeze beats).
- Test migration is REQUIRED and large (room tests drove plays via pitch/swing) — re-derive to "seeded rng → ready both → await auto-resolution"; NEVER weaken a gate; document every re-derivation.
- Client: UI restyle needs the unslop-ui pass; British English; no `any`/`@ts-ignore` without justification; no per-frame allocations in animation code; software-rasterizer safe (procedural textures only).
- Concurrent implementers do NOT commit; controller serialises. Worktree via superpowers:using-git-worktrees.

## File Structure

- Modify: `shared/src/constants.ts` (mirror POSTS/FIELDING_POSITIONS x; +AUTOPLAY block) + `shared/src/types.ts` (+`RollEvent`) + shared tests
- Create: `server/src/modules/AutoPlayModule.ts` + test
- Modify: `server/src/modules/FieldingModule.ts` (+`onRoll` dep) + test; `server/src/rooms/MatchRoom.ts` (beats, broadcasts, tombstones) + the room test migration
- Modify: `client/src/CharacterModels.ts` (bat prop + batting stance support), `client/src/RenderModule.ts` (batter view, windUp/swing animations)
- Create: `client/src/CameraControls.ts`; Modify: `client/src/SceneModule.ts` (skybox)
- Modify: `client/index.html`, `client/src/UIModule.ts` (restyle + roll banner), `client/src/DraftScreen.ts` (restyle hooks), `client/src/InputModule.ts` (remove play keys), `client/src/NetModule.ts` (+onRoll), `client/src/main.ts` (wiring)
- Create: `docs/superpowers/acceptance/autoplay-*` (Task 7)

**Sequencing:** T1 (shared mirror + contracts) → T2 (AutoPlayModule) → T3 (MatchRoom, heaviest) → T4 (models/animations) ∥ T5 (camera/skybox) — disjoint, NEITHER touches main.ts/PositioningControls → T6 (UI restyle + ALL wiring) → T7 (acceptance + docs).

---

### Task 1: Shared — orientation mirror, AUTOPLAY constants, RollEvent

**Files:** `shared/src/constants.ts`, `shared/src/types.ts`, shared tests; `server/test/*` re-derivations for hardcoded mirrored coordinates.

**Interfaces produced:**

```typescript
/** One automated contest's dice moment (broadcast as 'roll'). */
export interface RollEvent {
  contest: 'pitch' | 'swing' | 'run' | 'catch';
  actorId: string;
  /** Short human-readable flavour, e.g. 'spin 8 v read 4'. */
  detail: string;
  roll: number;      // the rng draw in [0,1)
  threshold: number; // success boundary the roll was compared against
  success: boolean;
}
```

Plus the GAME `AUTOPLAY_*` constants (Global Constraints values) and the mirror: negate x of every `POSTS` entry and every `FIELDING_POSITIONS` entry (BOWLING/BATTING squares sit at x=0 and stay; LEGAL_ZONE symmetric). Update the FIELD comment ("posts 1–4 run anticlockwise — first post at NEGATIVE x so it appears to the batter's right from the match camera").

- [ ] **Step 1:** Apply the constants/types changes + structural test updates (constants tests pin the new AUTOPLAY values; any post-coordinate pin flips sign; the LEGAL_ZONE-contains-all test passes unchanged by symmetry).
- [ ] **Step 2:** Run the FULL suite (`npm run check`). Server tests with hardcoded coordinates/aims fail honestly — re-derive each by mirroring the hardcoded x (e.g. test aims `{x: 0.55, …}` → `{x: -0.55, …}`; targets already reading CONST adapt automatically). Physics/room outcome tests must end at the SAME outcomes by symmetry — a test whose outcome CHANGES indicates a non-mirrored hardcoded value left behind, not a legitimate re-derivation; find it. Document every touched test in the report.
- [ ] **Step 3:** `npm run check` fully green. Controller commits: `feat(shared): counter-clockwise field orientation + autoplay contracts`.

---

### Task 2: AutoPlayModule (pure)

**Files:** Create `server/src/modules/AutoPlayModule.ts`, `server/test/AutoPlayModule.test.ts`.

**Interfaces produced (T3 consumes verbatim):**

```typescript
import type { Character, PitchInput, SwingInput, RollEvent, PitchAbilityMods } from '@carlquest/shared';

export interface RunSituation {
  ballHeld: boolean;
  /** Metres from the ball to the post the runner is heading for. */
  ballDistToTargetPost: number;
}

export function createAutoPlayModule(rng: () => number): {
  /** Bowler AI: spin magnitude stat-weighted, small aim scatter. Returns the wire-shaped input + the roll beat. */
  pitchDecision(pitcher: Character, mods: PitchAbilityMods): { input: PitchInput; roll: RollEvent };
  /**
   * Batter AI: timingError sampled uniform in ±AUTOPLAY_TIMING_NOISE_S — the REAL window chain in
   * resolveSwing then decides contact, so reflex/CANNON/spin-read/SWITCH all keep their effect.
   * effectiveWindow (for the broadcast's threshold/detail only) is computed via the shared formulas.
   * Aim: power-weighted zone roll across the legal fan (deep zones likelier with high power).
   */
  swingDecision(batter: Character, effectiveWindowS: number): { input: SwingInput; timingError: number; roll: RollEvent };
  /** Runner AI: pGo = clamp01(risk01 · 0.8 + AUTOPLAY_RUN_NERVE_W · s01(nerve) − 0.1 + AUTOPLAY_RUN_BASE·0)…
   * exact formula: risk01 = situation.ballHeld ? AUTOPLAY_RUN_HELD_RISK : clamp01(dist / AUTOPLAY_RUN_DIST_REF);
   * pGo = clamp01(AUTOPLAY_RUN_BASE + risk01 * 0.5 + AUTOPLAY_RUN_NERVE_W * s01(nerve)); go = rng() < pGo. */
  runDecision(runner: Character, situation: RunSituation): { go: boolean; roll: RollEvent };
};
```

- [ ] **Step 1: Failing tests** (seeded `createRng` from shared): exact decision reproducibility (same seed → same sequence); pitch spin magnitude correlates with the spin stat over many draws (kian rolls |spinInput| ≥ 0.5 more often than joe — statistical assertion over ≥200 draws with a fixed seed, deterministic); swing timingError always within ±AUTOPLAY_TIMING_NOISE_S and the roll's threshold equals the passed effectiveWindow (so CANNON/spin-read shrink the broadcast threshold); aim vectors always inside the legal horizontal fan and elevation bounds (reuse GAME.HIT_ELEVATION range); run pGo arithmetic pinned at boundary situations (held vs 30 m free) and nerve extremes (joe 2 vs carl 8).
- [ ] **Step 2: RED → implement → GREEN** (`npx vitest run test/AutoPlayModule.test.ts` from /server), whole shared+server typecheck clean. Controller commits: `feat(server): pure AutoPlayModule dice decisions`.

---

### Task 3: MatchRoom auto-beats + roll broadcasts + tombstones + test migration (heaviest)

**Files:** `server/src/modules/FieldingModule.ts` (+`onRoll?: (e: RollEvent) => void` dep, called with a RollEvent for every pCatch roll, guaranteed catch — success true, threshold 1, no rng draw — and fumble roll) + its test; `server/src/rooms/MatchRoom.ts`; `server/test/MatchRoom.test.ts`.

**Behaviour (binding):**
- On PLAY entry (and after a no-contact respawn — the missed-swing re-pitch loop) schedule the pitch beat at `simTime + GAME.AUTOPLAY_PITCH_DELAY_S`. At the beat: `autoPlay.pitchDecision(pitcher, pitcherMods)` → existing resolvePitch path (mods applied), broadcast the roll, store the pre-sampled `swingDecision` (computed NOW with the effective window from the shared formulas chain for this batter/pitcher).
- When the ball crosses the batting plane (the room already latches `contactTime`): apply the stored swing via the EXISTING `resolveSwing(stats, input, sampledTimingError, ctx)` path, broadcast the swing roll (success = contact).
- Run beats: after contact and at every runner post-arrival (`atPost` transitions the room already observes for exposure bookkeeping): `runDecision(runnerCharacter, situation)` → `running.setDecision(go)`; broadcast. Rate-limit consecutive run beats by `AUTOPLAY_BEAT_MIN_GAP_S` sim seconds (skip the broadcast, not the decision, if inside the gap).
- Fielding deps gain `onRoll: (e) => this.broadcast('roll', e)`.
- Tombstones: `handlePitch`/`handleSwing`/`handleRunDecision` reject everything with the exact prose `'plays resolve automatically'` (keep paused-first ordering; drop the role checks — the reason is unconditional).
- Beats freeze under pause automatically (they compare against simTime, which the paused tick doesn't advance) — verify, don't assume.

**Test migration:** `startPlay` unchanged (confirm/ready both). `pitchThenSwing*` helpers DELETED; play-driving tests become: create room with a seed (deterministic decisions), `startPlay`, `await waitForCondition(room, () => room.state.phase !== 'PLAY' || …)` for resolution / observe `playOutcome` via a collector. Outcome-specific tests (caught/run-out idioms that aimed at specific fielders) can no longer aim — re-derive: seed-search a SMALL documented range (≤ 30 seeds) in the test setup for a seed exhibiting each outcome class ONCE, then pin that seed as a constant with a comment (the M4/M5 precedent for legitimate seed selection). New tests: zero-client-message auto-resolution; tombstone rejections exact; `roll` broadcast order (pitch before swing before any run/catch) via a collector; pause mid-beats freezes (no roll broadcasts while paused across 1 s real time); WALL/CLUTCH integration tests re-derived to seeds.

- [ ] **Step 1:** FieldingModule onRoll (TDD, small).
- [ ] **Step 2:** Room beats implementation.
- [ ] **Step 3:** New auto-play room tests RED→GREEN.
- [ ] **Step 4:** Full migration; every re-derivation documented with before/after reasoning.
- [ ] **Step 5:** `npm run check` fully green ×2 runs (this file has flake history; also note the pre-existing WALL flake §6.4 — if it fires, re-derive per its logged suggestion rather than retrying blindly). Controller commits: `feat(server): automated play beats with dice-roll broadcasts`.

---

### Task 4: Client models — bat, batter stance, throw/hit animations (∥ T5)

**Files:** `client/src/CharacterModels.ts`, `client/src/RenderModule.ts`. Do NOT touch main.ts/PositioningControls/UIModule (T6 wires).

**Interfaces produced (T6 consumes):**
- `CharacterModel` gains `bat: THREE.Mesh` (hidden by default; simple cylinder+handle in the right hand).
- RenderModule: new `createBatterView(scene: THREE.Scene): BatterView` with

```typescript
export interface BatterView {
  /** Render the current batter at the batting square (null hides). `suppressed` hides without disposing (runner exists). */
  update(batterId: string | null, kit: KitId, suppressed: boolean): void;
  /** Play the bat swing (contact and miss both call it). */
  swing(): void;
  setTeams? — not needed (kit passed per update);
  dispose(): void;
}
```

- `FieldersView` gains `windUp(id: string): void` — bowler wind-up → release arm pose over ~0.6 s (timed so the release frame lands near ballLive; fire-and-forget, the rAF loop runs it).
- Batter stance: idle pose with bat visible (both hands towards the bat side, slight crouch); `swing()` sweeps the torso+arms over ~0.4 s then returns to stance.
- All animation timed poses in the existing rAF machinery; no per-frame allocations.

- [ ] **Step 1:** Implement; typecheck + eslint clean (main.ts untouched so the app still runs without the batter view — T6 wires it).
- [ ] Controller commits: `feat(client): batter view with bat, throw and swing animations`.

---

### Task 5: Client — orbit camera + skybox (∥ T4)

**Files:** Create `client/src/CameraControls.ts`; modify `client/src/SceneModule.ts` (skybox only). Do NOT touch main.ts/PositioningControls (T6 wires).

**Interfaces produced (T6 consumes):**

```typescript
export function createCameraControls(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera): {
  /** True while a drag is in progress or ended within the last ~150 ms (click suppression). */
  dragging(): boolean;
  reset(): void;   // classic view: position (0,12,-14), lookAt (2,0,10)
  detach(): void;
};
```

- Orbit around a fixed target (the pitch centre ≈ (0, 0, 12)): pointer-drag orbits (yaw free, polar clamped 10°–80°), wheel zooms radius (clamped ~12–55 m — never past the stands), `Home` key and double-click call `reset()`. Drag threshold ~5 px before it counts as a drag (below = click, `dragging()` false). Hand-rolled spherical maths preferred (no examples/jsm import weight); reuse scratch vectors.
- Skybox (SceneModule): replace the gradient dome with a procedural sky — sun disc + glow, graded horizon, scattered soft clouds — either a 6-face `CubeTexture` from canvases or an upgraded equirect dome texture (implementer's choice; must look right from ALL orbit angles now, not just the fixed view — clouds on the dome, no visible seams at the poles within the polar clamp).

- [ ] **Step 1:** Implement both; typecheck + eslint; quick Playwright screenshot loop for the skybox from two angles (scratchpad only), eyeball via Read. Controller commits: `feat(client): clamped orbit camera + procedural skybox`.

---

### Task 6: UI restyle + roll banner + all wiring

**Files:** `client/index.html`, `client/src/UIModule.ts`, `client/src/DraftScreen.ts`, `client/src/InputModule.ts`, `client/src/NetModule.ts`, `client/src/main.ts`, `client/src/PositioningControls.ts` (drag-suppression hook only).

**Binding:**
- **unslop-ui pass FIRST.** New identity per spec §5: dark glassy panels, hard diagonal cuts (clip-path, 4–6° skews), condensed uppercase display type (system stack), navy/maroon team accent slashes, high-contrast readouts. EVERY surface restyled: lobby, draft sheet, positioning panel, HUD board/feed/legend, result overlay. Parchment fully retired (including the old CSS variables).
- **Roll banner:** `UI` gains `showRoll(e: RollEvent): void` — centre-top flash ~1.4 s ("KIAN PITCHES — SPIN 8 v READ 4 — BEATEN!" style: build the line from `contest`/`actorId` name/`detail`/`success`), queueing gracefully when beats stack (max 2 visible, oldest drops); every roll also becomes a feed line.
- **NetModule:** `onRoll(callback: (e: RollEvent) => void)` for the `roll` broadcast.
- **InputModule:** REMOVE KeyP/Space/KeyR/KeyT/KeyA/KeyS/KeyD handling entirely (Enter/N + Escape remain); delete the spin InputState if now unused. Legend mapping in UIModule updated: positioning phases show mouse hints + Enter; PLAY shows "▶ play in progress — dice will decide"; GAME_OVER shows N/rematch.
- **main.ts wiring:** `createBatterView` instantiated with the views; per state change `batterView.update(state.currentBatterId || null, kitOf(batter), runnersHas(batterId))`; `net.onRoll` → `ui.showRoll` + feed + `contest === 'pitch' ? fielders.windUp(e.actorId) : contest === 'swing' ? batterView.swing() : …`; `createCameraControls(canvas, camera)` created at startup, `reset` untouched by matches, `dragging` handed to PositioningControls (constructor gains optional `isDragging?: () => boolean`; its click handler returns early when true).
- Rejection map: add the tombstone prose passthrough (it reads fine verbatim).

- [ ] **Step 1:** unslop-ui, then restyle + implement + wire.
- [ ] **Step 2:** typecheck + eslint; live smoke: two Playwright pages, draft through, READY both, WATCH an auto-play happen (assert a roll banner element appeared, playOutcome resolved with zero play keys — there are none), orbit the camera and reposition a fielder mid-PRE_PLAY, screenshots eyeballed. Controller commits: `feat(client): esports UI restyle, roll banners, autoplay wiring, camera hookup`.

---

### Task 7: Acceptance + docs

**Files:** Create `docs/superpowers/acceptance/autoplay-acceptance.mjs` (+ `.txt`, `autoplay-0*.png`); modify `CLAUDE.md` §6, `README.md` (controls table + gallery), `TUNING.md` (AUTOPLAY_* candidates).

- [ ] **Step 1: Scripted WS acceptance** (colyseus.js, seeded rooms): full game to GAME_OVER with ZERO play messages sent; tombstone rejections exact; roll broadcast sequence sane per play (pitch → swing → …, counts logged); counter-clockwise assert: the first runner's first post arrival has x < 0 (schema); pause mid-play freezes rolls.
- [ ] **Step 2: Browser acceptance** (two pages): restyled lobby/draft screenshots; ready both → watch the play: roll banner visible (screenshot), batter visible at the square WITH bat pre-contact (pixel/DOM assert), pitcher wind-up captured (screenshot timing on the pitch roll), run direction visually right (screenshot); orbit the camera (before/after screenshots) + reset; reposition from an orbited camera works.
- [ ] **Step 3: Docs.** §6.1 (redesign recorded: what changed incl. the §7 supersession and the orientation mirror), §6.2 rows (user-directed redesign; mirror; AUTOPLAY constants; timing-error sampling design — real window chain preserved; tombstone prose), §6.3 entry, §6.4 sweep (remove stale play-key items: paused key gating note, swing-timing latency note — both moot without player swings; keep what still applies). README: controls table rewritten (management actions only), gallery updated with an auto-play/roll-banner shot. TUNING.md: AUTOPLAY_* values.
- [ ] **Step 4:** `npm run check` green ×2; no lock churn; commit `docs: autoplay redesign acceptance evidence and project log`.

---

## Self-Review Notes (already applied)

- Spec §1→T1, §2→T2+T3, §3→T4(+T6 wiring), §4→T5(+T6), §5→T6, §6→T5, §7→per-task+T7, §8 respected.
- Type consistency: `RollEvent`/`RunSituation`/`createAutoPlayModule` names cross-checked T1–T3; `BatterView`/`windUp`/`showRoll`/`onRoll`/`dragging`/`isDragging` cross-checked T4–T6.
- The swing sampling deliberately keeps resolveSwing authoritative (T2's error sample + the real window = contact), so no ability regression is possible by construction; the broadcast threshold is presentation-only.
- The missed-swing re-pitch loop (no-contact respawn) must re-schedule the pitch beat — named explicitly in T3 to avoid the stalled-play trap the M10 harness hit.
- T4/T5 both told not to touch main.ts/PositioningControls → genuinely parallel; T6 owns every wire.
