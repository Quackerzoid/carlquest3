# Visual Overhaul Design — character models + stadium world (post-M10, client-only)

Date: 2026-07-04. Status: USER-APPROVED (this session).
User decisions: **procedural low-poly figures** (no external assets); **alive-but-simple
animation** (facing, idle bob, run swing/lean, bowler pose); **small stadium** world (stands,
floodlights, boards — not the village green). Emphatic user requirement: **characters must NOT
be pills** — every model is a limbed humanoid with a readable, distinct silhouette; a single
capsule/sphere body is a design failure.

## 0. Hard guarantees

- **Zero gameplay impact.** Only `client/src/CharacterModels.ts` (new), `client/src/RenderModule.ts`,
  `client/src/SceneModule.ts` and minimal `client/src/main.ts` wiring change. Nothing under
  `server/` or `shared/` may change; the server test suite must be byte-identical green (357/357).
- **Every RenderModule public signature is preserved**: `createBallView/createFieldersView/
  createRunnersView(scene)`, `update(iterable)`, `pickId(raycaster)`, `setSelected(id|null)`,
  `markOut(id)`, `dispose()`. The per-frame lerp, dying-runner retention (`dyingUntil` +
  revival guard) and single-source SelectionStore behaviour are unchanged.
- Works on the software rasterizer (headless acceptance): no dynamic shadow maps, no
  post-processing, modest polycount (target: whole scene under ~60k triangles incl. crowd
  instancing), all textures procedural canvas (no asset files, no network fetches).

## 1. Character models (`client/src/CharacterModels.ts`, new)

`buildCharacterModel(character: Character, kit: KitId): CharacterModel` where
`KitId = 'A' | 'B' | 'neutral'` and:

```ts
interface CharacterModel {
  group: THREE.Group;            // add to scene; position/rotate the GROUP only
  pose: {
    leftArm: THREE.Group; rightArm: THREE.Group;   // shoulder pivots
    leftLeg: THREE.Group; rightLeg: THREE.Group;   // hip pivots
    torso: THREE.Group;                            // lean/bob pivot
  };
  ring: THREE.Mesh;              // feet ring — status colours (hidden by default)
  ball: THREE.Mesh;              // in-hand ball prop (hidden unless holder)
  setTint(colour: number | null): void; // traverse emissive tint (out = red); null restores
  dispose(): void;
}
```

- **Rig (the no-pills rule):** head (sphere) on a neck, torso (bevelled box or scaled cylinder —
  NOT a capsule enclosing the whole figure), pelvis, two arms and two legs as pivoted groups
  (upper limb cylinder + hand/boot), standing on a translucent blob-shadow disc. Silhouettes must
  read at gameplay camera distance: height, shoulder width, belly girth and limb thickness vary
  per character.
- **Per-character visual spec table** (hand-tuned, stats-informed): carl — tall confident opener,
  captain's armband; kian — bowler's flat cap (CURVEBALL_MASTER), wiry; laurie — very long arms
  (LONG_REACH), tall; josh — lean sprinter with keeper's gloves (QUICK_DRAW); joel — barrel
  chest, rolled sleeves (CANNON_ARM); darcy — symmetric build, two wristbands (SWITCH); jonty —
  squat, wide, headband (IMMOVABLE); robbie — big forearms, heavy boots (POWER_BASE); joe —
  short, scrawny, oversized shirt (BUTTERFINGERS); ricy — athletic all-rounder, tidy kit
  (POWERHOUSE); whale — a rounded GIANT, ~1.8× standard height and ~2.5× bulk, tiny flippers-ish
  arms (WALL) — still limbed, not a pill. Skin tones and hair colours/styles vary across the
  roster (hair as simple cap/quiff/bun geometry).
- **Kits:** shirt + trim colours by side; the two kit palettes are chosen in the implementation's
  unslop-ui pass to sit with the parchment/gold UI identity (suggested starting point: deep navy
  vs maroon with cream trim; final call at implementation). `neutral` kit (undrafted/edge cases)
  = grey. Kit applies to shirt only — skin/hair/accessory stay per-character.

## 2. Status cues re-homed (same APIs)

- Holder: gold `ring` shown + `ball` prop shown in the throwing hand (replaces whole-mesh gold
  tint). The separate scene ball hides while held exactly as today (`ballLive` handling unchanged).
- Selected: accent-coloured `ring` (gold family, distinct from holder — e.g. hollow vs filled or
  pulsing opacity) — replaces the scale pop.
- Out: existing topple (group rotation) + `setTint(0xred)` traverse — MUST remain
  pixel-detectable red from the acceptance camera (the M10 technique).
- Priority when overlapping (holder selected, etc.): out > selected > holder for the ring; tint
  independent.

## 3. Small stadium (SceneModule overhaul)

- **Bowl:** a low oval of terraced stands (3–5 steps) ringing the legal field with a gap behind
  the batting end; crowd = `InstancedMesh` of small varied-colour blobs on the terraces
  (thousands of instances, one draw call — cheap even on the software rasterizer).
- **Floodlights:** four corner pylons with emissive lamp heads (no actual shadow casting).
- **Boundary boards:** a ring of advertising hoardings inside the stands carrying
  procedural-canvas signage — in-fiction only ("CARL QUEST SPORTS", "THE WHALE STANDS FIRM",
  "RICY'S ALL-ROUNDER ACADEMY" — implementer's wit, British English, no real brands).
- **Pitch:** grass via a procedural canvas texture with mow stripes; chalk-white markings:
  batting/bowling squares, running arcs post→post, a boundary ring; posts upgraded with small
  flags. All existing gameplay-relevant positions (posts, squares) render at their CONST.FIELD
  coordinates exactly as before — markings are cosmetic overlays.
- **Sky + light:** warm gradient sky (large inverted sphere or scene background texture), gentle
  fog, hemisphere light + one directional key light (no shadow maps); blob shadows under
  characters come from the models (§1).
- Camera unchanged (framing already proven); renderer settings unchanged apart from background.

## 4. Animation (purely visual, in the existing rAF view loops)

- Facing: yaw-lerp each figure towards its movement direction (derived from target deltas the
  views already track); idle characters keep their last facing (fielders default facing the
  batting square).
- Idle: subtle sine breathing bob (torso pivot).
- Moving: speed-scaled arm/leg swing (opposite phase) + slight forward torso lean; thresholds off
  the same target-delta the lerp uses — no new state inputs.
- Holder: wound-up bowler pose (throwing arm cocked) while `hasBall`.
- Out: topple overrides posing (frozen, as today). No skeletal system, no event-triggered
  clips (swing/catch celebrations are out of scope — user chose alive-but-simple).

## 5. Wiring (main.ts, minimal)

- Views gain `setTeams(aIds: readonly string[], bIds: readonly string[])`, called from the
  existing `onStateChange` (from `state.squadAIds/squadBIds`); a model is (re)built when a
  character's kit assignment first becomes known or changes (in practice: once after the draft).
  Before the draft, models render in `neutral` kit.
- Everything else flows through existing update() data.

## 6. Verification and acceptance

- `npm run check` fully green (server/shared byte-untouched — verify via diff stat).
- New browser acceptance (`docs/superpowers/acceptance/visual-*`): screenshots — the stadium wide
  shot, a line-up of ALL 11 models (drive via a draft into positioning, both kits visible), and
  mid-play; pixel assertions: (a) two different characters' screen regions differ materially
  (anti-pill regression: e.g. whale vs joe bounding-height ratio from pixels), (b) the topple red
  still detectable (M10 technique), (c) stands/sky colours present in expected regions; plus a
  functional re-run of the panel-select → canvas ground-click reposition flow (M8 technique) to
  prove group picking works.
- Frozen old harnesses are NOT re-run or edited (their capsule-colour pixel checks describe the
  old world — evidence of their own milestones only).

## 7. Out of scope

- External/skeletal assets; event-triggered animation clips; dynamic shadows; weather/time of
  day; crowd audio (there is no audio at all); performance work beyond the stated budgets;
  any server/shared/UI-panel change.
