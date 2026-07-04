# Visual Overhaul Implementation Plan (post-M10, client-only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinct procedural low-poly humanoid models for all 11 characters (NO pills), a small-stadium world, and simple life-giving animation — with zero gameplay impact.

**Architecture:** New `CharacterModels.ts` owns the 11 rigs behind a `CharacterModel` interface; `RenderModule` keeps its exact public API but renders/animates the rigs (group picking, feet-ring status cues, traverse tint); `SceneModule` is rebuilt as the stadium. Server/shared byte-untouched.

**Tech Stack:** Three.js primitives + InstancedMesh + procedural canvas textures. No asset files.

**Design spec:** `docs/superpowers/specs/2026-07-04-visual-overhaul-design.md` — read §0 (hard guarantees) and §1 (the no-pills rule) before any task.

## Global Constraints

- CLIENT-ONLY: nothing under `server/` or `shared/` may change; server suite stays 357/357 untouched.
- **NO PILLS (user-emphatic):** every character is a limbed humanoid — head on a neck, torso that is NOT a whole-figure capsule, two pivoted arms, two pivoted legs. Silhouettes must differ visibly at gameplay camera distance (whale ≈1.8× height/2.5× bulk of standard; joe short+scrawny; jonty squat+wide; laurie's arms visibly long...). A reviewer finding any single-capsule body fails the task.
- RenderModule public signatures preserved verbatim: `createBallView/createFieldersView/createRunnersView(scene)`, `update(iterable)` shapes, `pickId(raycaster): string | null`, `setSelected(id | null)`, `markOut(id)`, `dispose()`; plus the NEW `setTeams(aIds: readonly string[], bIds: readonly string[])` on fielders and runners views.
- Per-frame lerp, `dyingUntil` retention + revival guard, SelectionStore single-source rule: all unchanged in behaviour.
- Software-rasterizer safe: no shadow maps, no post-processing, procedural canvas textures only, whole scene ≤ ~60k triangles (crowd via ONE `InstancedMesh`).
- Verification per task: `/client` `npx tsc --noEmit -p tsconfig.json` + root `npx eslint client/src`; behaviour proof is Task 4's browser acceptance. `npm run check` green at task ends.
- British English; no `any`/`@ts-ignore` without justification. Concurrent implementers do NOT commit; controller serialises. Worktree via superpowers:using-git-worktrees.

## File Structure

- Create: `client/src/CharacterModels.ts` (rigs + visual spec table — the only place character looks live)
- Modify: `client/src/SceneModule.ts` (stadium), `client/src/RenderModule.ts` (rig consumption + animation), `client/src/main.ts` (setTeams wiring only)
- Create: `docs/superpowers/acceptance/visual-*` (Task 4)

**Sequencing:** Task 1 (models) ∥ Task 2 (stadium) — disjoint files → Task 3 (RenderModule + main.ts, consumes Task 1) → Task 4 (acceptance + docs).

---

### Task 1: CharacterModels.ts — the 11 rigs

**Files:**
- Create: `client/src/CharacterModels.ts`

**Interfaces (Task 3 depends on these exact names):**

```typescript
import * as THREE from 'three';
import type { Character } from '@carlquest/shared';

export type KitId = 'A' | 'B' | 'neutral';

export interface CharacterModel {
  group: THREE.Group;      // position/rotate THIS; internal parts are relative
  pose: {
    leftArm: THREE.Group;
    rightArm: THREE.Group;
    leftLeg: THREE.Group;
    rightLeg: THREE.Group;
    torso: THREE.Group;
  };
  /** Feet ring for status cues; hidden by default. Set .visible and .material colour. */
  ring: THREE.Mesh;
  /** In-hand ball prop; hidden unless the character holds the ball. */
  ball: THREE.Mesh;
  /** Approximate standing height in metres (whale ≈ 3.1, joe ≈ 1.3) — for camera/tests. */
  height: number;
  /** Emissive traverse tint (out = red); null restores originals. */
  setTint(colour: number | null): void;
  dispose(): void;         // dispose geometries + per-model materials
}

export function buildCharacterModel(character: Character, kit: KitId): CharacterModel;
/** Kit shirt palettes (chosen in the unslop pass): exported so tests/acceptance can assert. */
export const KIT_COLOURS: Record<KitId, { shirt: number; trim: number }>;
```

Implementation requirements (binding):

- A `VISUALS` table keyed by character id: `{ heightM, shoulderW, bellyR, limbR, skin, hair, hairStyle: 'crop' | 'quiff' | 'bun' | 'bald' | 'curls', accessory }` — one entry per §1 of the design spec (carl armband, kian flat cap, laurie long arms, josh gloves, joel rolled sleeves + barrel chest, darcy wristbands, jonty headband + squat, robbie forearms + boots, joe oversized shirt + scrawny, ricy tidy athletic, whale rounded giant with small arms). Unknown ids fall back to a `DEFAULT` build (defensive — roster growth).
- Rig construction: head sphere + neck; torso = bevelled/scaled cylinder or box (never a full-figure capsule); pelvis block; arms/legs = cylinder upper + smaller lower/hand/boot inside pivot Groups positioned at shoulders/hips so rotation swings them naturally; blob-shadow disc (dark, ~0.35 opacity, radius ∝ bulk) as part of the group at y≈0.01; `ring` = torus/annulus at the feet slightly larger than the shadow; `ball` parented to the right hand.
- Materials: `MeshLambertMaterial` only (matches the scene's lighting model); per-model instances for tintable parts (setTint walks the group flipping `emissive`; store originals for restore).
- All dimensions in metres consistent with the field scale (standard figure ≈ 1.7 m; camera sits at y=12 looking across ~30 m — chunky proportions read better than realistic ones: heads ~1.4× realistic scale, limbs thick).
- NO external imports beyond three + shared types. Pure construction — no per-frame logic here (animation is Task 3's).

- [ ] **Step 1:** Write the module per the contract. Self-check EVERY character against the no-pills rule and the silhouette list; add a file-header comment table summarising each character's distinguishing look.
- [ ] **Step 2:** Verify — `/client` `npx tsc --noEmit -p tsconfig.json`; root `npx eslint client/src`. Controller commits: `feat(client): procedural character rigs for all 11 characters`.

---

### Task 2: SceneModule stadium (parallel with Task 1)

**Files:**
- Modify: `client/src/SceneModule.ts`

**Interfaces:**
- `createScene(canvas)` return shape UNCHANGED: `{ scene, camera, renderer, start }` (main.ts destructures exactly these; `start(onFrame?)` if it currently takes a callback — read the file first and keep whatever surface exists).
- Camera position/lookAt unchanged (framing is proven by four milestones of screenshots).

Implementation requirements (binding; budgets from spec §0/§3):

- **Grass:** ground plane textured by a procedural canvas (~512²): two-tone green mow stripes aligned with the bowling direction, subtle noise. `RepeatWrapping` sized so stripes are ~2 m wide.
- **Chalk markings** (thin white meshes or canvas-drawn onto the grass texture — implementer's choice, canvas preferred for zero extra draw calls): batting square, bowling square, running arcs between consecutive posts (quarter-ish arcs through the post ring), boundary ring at the LEGAL_ZONE edge. All geometry positions read from `CONST.FIELD` — no hardcoded coordinates.
- **Posts:** keep exact CONST.FIELD.POSTS positions; visual upgrade: slightly thicker pole + small triangular flag (two-tri geometry) at the top.
- **Stands:** an oval ring of 3–5 terrace steps (BoxGeometry segments arranged around the field outside LEGAL_ZONE, gap behind the batting end); muted concrete tones.
- **Crowd:** ONE `THREE.InstancedMesh` (low-poly blob: sphere or cone, ≤ 60 tris) with ~2,000–4,000 instances scattered on the terrace steps, per-instance colour via `setColorAt` from a small palette. Deterministic placement (seeded LCG inside the module — client visuals may use any seed constant; do NOT import server rng).
- **Floodlights:** four corner pylons (cylinder mast + tilted head panel of small emissive rectangles). Emissive materials only — no light sources added per pylon.
- **Boards:** a ring of hoardings (thin boxes) inside the stands, textured from a procedural canvas strip of in-fiction signage — British English, no real brands ("CARL QUEST SPORTS", "THE WHALE STANDS FIRM", implementer's wit welcome). One shared texture atlas canvas, repeated with offsets.
- **Sky/fog:** warm gradient sky via a large `BackSide` sphere with a canvas gradient texture (or `scene.background` gradient texture); `THREE.Fog` tuned so the far stand softens but the field stays crisp.
- **Lighting:** `HemisphereLight` (sky/ground tones) + one `DirectionalLight` key. NO shadow maps.
- Triangle budget: whole scene ≤ ~60k incl. crowd — count roughly in a comment.

- [ ] **Step 1:** Read the current SceneModule fully, then rebuild per the list, keeping the export surface and camera identical.
- [ ] **Step 2:** Verify — typecheck + eslint clean; quick visual sanity via `npm run dev` + one Playwright screenshot saved to the scratch dir (NOT committed) and eyeballed via Read. Kill the server after. Controller commits: `feat(client): stadium world — stands, crowd, floodlights, boards, grass, sky`.

---

### Task 3: RenderModule rig consumption + animation + wiring

**Files:**
- Modify: `client/src/RenderModule.ts`, `client/src/main.ts`

**Interfaces:**
- Consumes: Task 1's `buildCharacterModel`/`CharacterModel`/`KitId`/`KIT_COLOURS`.
- Produces: fielders and runners views gain `setTeams(aIds: readonly string[], bIds: readonly string[]): void`; everything else keeps its signature.

Implementation requirements (binding):

- **Model lifecycle:** views keep a `Map<string, { model: CharacterModel; kit: KitId; target: …; facing: number; dyingUntil: … }>`. Characters resolve via shared `CHARACTERS` lookup by id (tolerant fallback for unknown ids → DEFAULT build). `setTeams` records the id→kit map; a model whose kit assignment CHANGES (neutral → A/B after the draft) is disposed and rebuilt with the right kit (rare, once per character).
- **Picking:** `pickId` raycasts `intersectObjects([...groups], true)` and walks `object.parent` chain up to a registered group (keep a `Map<THREE.Object3D, string>` of group→id). Exclude ring/shadow/ball from picking hits OR accept them (they belong to the character — accept, simpler).
- **Status cues:** holder → ring visible gold + `ball` prop visible (scene ball handling unchanged — `ballLive` already hides it while held); selected → ring visible in the accent style (hollow/pulse — pick one, consistent with the M8 gold accent); out → topple (rotate the GROUP as today) + `model.setTint(red)`; priority out > selected > holder for the ring. Restore cleanly on state change (tint null, ring hidden).
- **Animation (in the existing rAF loops, spec §4):** per model keep `facing` (yaw): when the frame's lerp step moves the group by > ~1 cm, yaw-lerp towards `atan2(dx, dz)`; speed estimate = frame displacement / dt drives leg/arm swing amplitude+frequency (sine, opposite phase, clamped) and a small torso lean; idle (below threshold) → breathing bob (torso y-scale or slight y offset sine, subtle); holder → right arm cocked pose overriding swing; dying/toppled → all posing frozen (as today). Constants at module top with comments (swing freq ∝ speed, max lean ~0.15 rad).
- **Ball view:** keep the sphere but re-skin: slightly larger, seam texture via tiny procedural canvas, unchanged behaviour.
- **main.ts wiring:** in the existing `onStateChange`, call `fielders.setTeams([...state.squadAIds], [...state.squadBIds])` and same for runners (defensive spreads; empty pre-draft → everyone neutral). NOTHING else in main.ts changes.
- **markOut/dyingUntil/revival guard:** preserve the exact M10 semantics (retention, revival reset, no-op warn).

- [ ] **Step 1:** Read the current RenderModule fully (it changed in M10). Implement per the contract.
- [ ] **Step 2:** Verify — typecheck + eslint; live smoke: `npm run dev`, one Playwright page through create+join+draft (reuse the m8 helper pattern) to positioning, screenshot to the scratch dir, eyeball models + stadium render and confirm zero console errors; check panel-row select still highlights (ring appears). Kill server. Controller commits: `feat(client): render character rigs with life animation and status rings`.

---

### Task 4: Browser acceptance + docs

**Files:**
- Create: `docs/superpowers/acceptance/visual-acceptance.mjs`, `visual-acceptance.txt`, `visual-0*.png`
- Modify: `CLAUDE.md` §6, `README.md` (swap the screenshot gallery to the new look — same table layout, new PNGs), `TUNING.md` only if warranted

- [ ] **Step 1: Acceptance harness** (assertion-based, exit non-zero; patterns: m8/m10 harnesses): two pages, create/join, full draft (helper), reach INITIAL_POSITIONING; screenshots: `visual-01-stadium.png` (wide), `visual-02-lineup.png` (positioning phase — both squads on/near field showing distinct models + both kits), `visual-03-play.png` (mid-play). Pixel assertions: (a) **anti-pill/distinctness** — project whale's and joe's positions through the camera (m8's Node-side camera-replica technique) and assert whale's rendered vertical extent ≥ 1.6× joe's; (b) stadium present — sample expected sky-region and stand-region pixels differ from the old flat background/green; (c) **picking still works** — the m8 panel-select → ground-click reposition flow moves a fielder (schema assert); (d) **topple still detectable** — if an out occurs within budget, assert red pixels near the out runner (honest log if none occurred); (e) zero console/page errors throughout. Log → visual-acceptance.txt.
- [ ] **Step 2: Docs.** CLAUDE.md §6.1 (post-ship visual overhaul recorded — no milestone number; note zero server/shared change verified by diff stat), §6.2 rows (procedural rigs + VISUALS table as the single looks-source; kit colours; stadium budgets; deterministic client-visual LCG separate from server rng), §6.3 entry, §6.4 (remove/supersede the "capsule" phrasing items if any still describe the old look — check the render-smoothing and topple notes' wording still holds). README: replace the four gallery screenshots with visual-01/02/03 (+ keep one HUD shot), update the capsule mention in the abilities blurb if present.
- [ ] **Step 3:** `npm run check` green (server untouched); kill servers; no lock churn; commit `docs: visual overhaul acceptance evidence and project log`.

---

## Self-Review Notes (already applied)

- Spec §0→Global Constraints, §1→T1, §2→T3, §3→T2, §4→T3, §5→T3 (main.ts), §6→T4, §7 respected.
- Type consistency: `CharacterModel`/`KitId`/`KIT_COLOURS`/`setTeams` names match across T1/T3/T4.
- The scene ball's `ballLive` visibility flow is explicitly unchanged (T3) — the in-hand `ball` prop is a separate mesh owned by the model, avoiding any interaction with rest/timeout logic.
- Old frozen harnesses assert capsule-blue pixels — NOT re-run, NOT edited (their milestones' evidence). The new harness carries the picking/topple regression duties forward.
