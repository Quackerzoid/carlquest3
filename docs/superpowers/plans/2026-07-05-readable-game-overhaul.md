# Readable-Game Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Field ×2 at real speeds, real loft, catch arming, relay throws, outcome hold and faster miss-respawn (server); walking world with a batting bench, ball roll/highlight/trail/holder-icon, ground-up minimal-mascot characters, and a bold arcade-pop UI with tooltips and a proper READY button (client).

**Architecture:** All server behaviour changes land in ONE task (they each shift the shared rng stream / flight ratios, so the seeded room tests migrate exactly once, in the following task). Client work then proceeds: mascots first (new CharacterModels contract), then render presentation, then UI/stadium/camera, then acceptance.

**Tech Stack:** unchanged (TS strict, Colyseus, Rapier, Three.js, Vitest, Playwright).

**Design spec:** `docs/superpowers/specs/2026-07-05-readable-game-overhaul-design.md` + the evidence in `2026-07-05-bug-investigation.md` — read both before any task.

## Global Constraints

- Formulas (§5) and abilities untouched. New tunables in `shared/src/constants.ts` GAME/FIELD, exact values: FIELD ×2 scaling per spec §A; `PLAY_TIMEOUT_S: 12`, `AUTOPLAY_RUN_DIST_REF: 60`, `AUTOPLAY_PITCH_DELAY_S: 1.5`, `AUTOPLAY_BEAT_MIN_GAP_S: 1.0`, `AUTOPLAY_LOFT_MIN_DEG: 5`, `AUTOPLAY_LOFT_MAX_DEG: 50`, `CATCH_ARM_DISTANCE_M: 4`, `RELAY_ADVANTAGE_M: 6`, `MISS_RESPAWN_S: 1.5`, `OUTCOME_HOLD_S: 1.5`.
- Client walking constant `WALK_SPEED_M_S ≈ 3` is a client view constant (presentation-only, not shared).
- AutoPlayModule draw-count contract CHANGES (loft adds a draw) — update the documented contract in both file headers deliberately; seeded tests re-pin ONCE in Task 2.
- Rejection prose/tombstones/pause semantics unchanged. Outcome hold must be pause-safe (sim-time) and rematch/disposal-safe.
- Test migration discipline as always: gates never weakened, every re-derivation documented; scaling invariant: outcome CLASSES may legitimately shift where flight/run ratios changed — but each shifted test must be re-reasoned, not blindly re-pinned.
- unslop-ui pass for the UI task. British English. No per-frame allocations. Concurrent implementers don't commit; controller serialises. Worktree via superpowers:using-git-worktrees.

## File Structure

- T1: `shared/src/constants.ts` (+tests), `server/src/modules/AutoPlayModule.ts` (+test), `server/src/modules/FieldingModule.ts` (+test), `server/src/rooms/MatchRoom.ts` (hold + respawn)
- T2: `server/test/MatchRoom.test.ts` (single migration pass)
- T3: `client/src/CharacterModels.ts` (ground-up mascot rework, same contract shape)
- T4: `client/src/RenderModule.ts` (walking world, bench, ball presentation, holder icon)
- T5: `client/index.html`, `client/src/UIModule.ts`, `client/src/DraftScreen.ts`, `client/src/SceneModule.ts` (stadium auto-rescale verify + camera), `client/src/CameraControls.ts` (clamp rescale), `client/src/main.ts` (READY button wiring, bench wiring)
- T6: `docs/superpowers/acceptance/readable-*` + CLAUDE.md §6 + README + TUNING.md

**Sequencing:** T1 → T2 → T3 → (T4 ∥ T5 — disjoint files; neither touches main.ts except T5) → T6.

---

### Task 1: Server behaviour change-set (one coherent landing)

**Files:** `shared/src/constants.ts` + `shared/test/constants.test.ts`; `server/src/modules/AutoPlayModule.ts` + test; `server/src/modules/FieldingModule.ts` + test; `server/src/rooms/MatchRoom.ts`.

**Binding behaviours:**
1. **Field ×2 (shared):** scale ×2: every `POSTS` entry (x AND z), `BOWLING_SQUARE.z`, every `FIELDING_POSITIONS` entry, `LEGAL_ZONE` bounds, `BATTING_SQUARE_KEEPOUT` (→6), `GROUND_HALF_EXTENT` (→80). `BATTING_SQUARE` stays origin; square SIZES unchanged; `POST_SENSOR_RADIUS` unchanged. Update the derived-comment maths. Structural tests re-pin.
2. **Tunables:** the Global Constraints values (PLAY_TIMEOUT 12 etc.).
3. **Loft (AutoPlayModule.swingDecision):** ONE additional rng draw samples elevation `loftDeg = LOFT_MIN + draw × (LOFT_MAX − LOFT_MIN)`; aim y-component = tan(loftDeg°) × horizontal length (the HitModule clamp still applies). Draw-count contract: swingDecision 2 → 3 draws; update BOTH header docs. Unit tests: elevation always within [5°, 50°] as launch angle after normalisation; draw count pinned.
4. **Catch arming (FieldingModule):** record the flight origin at each `applyHit`-initiated flight (the module knows flights via its existing tick inputs — implement as: the room passes launch position when contact happens; cleanest surface: FieldingModule gains `armFlight(origin: Vec3)` called by the room at applyHit, and NO catch/gather attempt happens while `dist(ball, origin) < CATCH_ARM_DISTANCE_M`; throws (applyThrow flights) arm immediately (relay catches stay live); reset() clears. Unit tests: contact-point catch impossible (backstop-at-contact repro from the investigation), 4 m flight arms, throw flights unaffected, no rng draws while unarmed (call-count).
5. **Relay throws (FieldingModule throw targeting):** when throwing at threatened post P: if another fielder F (not the holder) satisfies `dist(F, P) + RELAY_ADVANTAGE_M < dist(holder, P)` AND `dist(F, P) < dist(holder→P direct throw distance)`, target the throw at F's position instead (F gathers on arrival via normal radius entry and re-throws next hold cycle). Pick the F nearest P among qualifiers. Unit tests: qualifying relay chosen (nearest-to-post wins), no qualifier → direct throw unchanged, holder himself excluded.
6. **MatchRoom:** (a) **missed-pitch respawn**: the no-contact branch respawns at `MISS_RESPAWN_S` after the swing beat resolved as a miss (or after plane-cross with no swing… the pending-swing path always swings; keep the rest-fallback), re-scheduling the pitch beat as today; (b) **outcome hold**: split `endPlay` into `resolvePlayNow()` (settle/rules/broadcast/lastOutcome — unchanged content) and `finalisePlay()` (ball respawn, fielding reset/rebuild, runner reset-if-innings-changed, syncs) executed `OUTCOME_HOLD_S` sim-seconds later via a scheduled sim-time hook in tick; between the two, PLAY-phase message tombstones still apply, no beats fire, ball stays where it died, runners stay put (the schema keeps last play state — clients get the tableau). Pause-safe (sim time), rematch/dispose short-circuits pending finalisation, GAME_OVER path holds too then finalises.
7. Run beats situation distance uses live ball as today (RUN_DIST_REF rescaled covers the ×2).

- [ ] Steps: shared changes + structural tests → module TDD (each unit file green) → room compile-level changes. Verify: `/shared` green; `npx vitest run test/AutoPlayModule.test.ts test/FieldingModule.test.ts test/PhysicsModule.test.ts test/PitchModule.test.ts test/HitModule.test.ts test/RulesModule.test.ts test/DraftModule.test.ts test/PositioningModule.test.ts` green; `npx tsc --noEmit -p server/tsconfig.json` clean. **MatchRoom.test.ts is EXPECTED red at this point** — that is Task 2's single migration (state this in the report; do not touch the room tests beyond compile fixes).
- [ ] Controller commits: `feat(server): field x2, loft, catch arming, relay throws, outcome hold, fast miss-respawn`.

---

### Task 2: Room-test single migration pass

**Files:** `server/test/MatchRoom.test.ts` only (helpers within it).

- Re-derive under the combined new world: ×2 geometry (reposition coordinates, corridor spots — derive from CONST where possible), shifted rng stream (loft draw) → re-pin seeds via the documented bounded-search idiom (≤30 seeds per outcome class, named constants, comments), longer plays (loft + ×2 + pacing: drive-loop tick budgets and waitForCondition maxTicks scale — compute from PLAY_TIMEOUT_S/pacing constants, don't hardcode magic tick counts), outcome-hold aware (post-playOutcome, fielder slots change only after OUTCOME_HOLD_S — existing tests that assert immediate PRE_PLAY state add a wait; NEW test: slots unchanged until the hold elapses, then rebuilt), catch-arming aware (contact-tick catches no longer exist — tests that relied on instant backstop catches re-derive; NEW test: a play's catch event never occurs within 4 m of launch — assert from roll timing or ball state), relay (room-level: a seeded play exhibiting a relay throw — bounded seed search; assert two throw events or holder change to the relay fielder before the post), missed-pitch respawn timing test (~MISS_RESPAWN_S not ~7 s).
- Full suite `npm run check` green ×2 (the suite is ~12+ min; budget accordingly). WALL/CLUTCH/full-game marquee tests re-pinned as needed with reasoning.
- [ ] Controller commits: `test(server): room suite migrated to the x2 loft-armed relay world`.

---

### Task 3: Minimal-mascot characters (ground-up)

**Files:** `client/src/CharacterModels.ts` (rewrite).

- Replace the limb rigs entirely. Per character: ONE body-head blob geometry (LatheGeometry profile or merged sphere-capsule — a single mesh; size/shape per character: whale enormous & spherical, joe tiny, jonty squat-wide, laurie tall), **painted canvas texture** per character (single 256–512² canvas: face — eyes/brows/mouth with personality (carl confident, joe worried, jonty stoic…), kit body colour + trim + big painted number (pick stable numbers 1–11 by roster order), painted tells: kian's cap band, darcy's wristband stripes on the blob, robbie's big painted gloves…, subtle shading); minimal EXTRA geometry only where painting can't sell it (kian's cap brim disc, jonty's headband torus — keep ≤2 extra meshes per character).
- **Floating sphere hands** (two spheres, no arms), positioned beside the body; `bat` prop parks into the right hand sphere; held ball parks into a hand sphere.
- Contract PRESERVED in shape: `buildCharacterModel(character, kit): CharacterModel` with `group/ring/ball/bat/height/setTint/dispose`; `pose` surface CHANGES deliberately to `{ body: Group; leftHand: Group; rightHand: Group }` (no legs/arms) — Task 4 owns the consumer update; KIT_COLOURS reworked to the arcade-pop palette family (brighter navy/maroon reads; exported names stable).
- Texture painting = deterministic canvas code (no rng, no assets). Lambert materials. Per-model dispose incl. textures.
- [ ] Verify: typecheck (RenderModule will be broken until T4 — acceptable ONLY if same-task compile stubs are avoided by landing T3+T4 together at commit time; therefore: T3's implementer verifies `tsc` on CharacterModels in isolation is impossible — instead T3 hands off with the file compiling EXCEPT RenderModule consumers, documents the new pose surface, and the controller holds the commit until T4 lands and the whole client typechecks). Controller commits T3+T4 together or sequentially within minutes; review separately.

---

### Task 4: Render presentation — walking world, bench, ball life (after T3)

**Files:** `client/src/RenderModule.ts`.

- **Consume the mascot contract** (pose = body/hands): rewrite posing — waddle/bob + lean while moving (body rock ± hand counter-swing), idle breath, wind-up = right hand orbits back then whips, bat swing = bat hand sweeps, carry = ball visible in hand sphere. markOut topple/tint/dyingUntil semantics preserved on the blob.
- **Phase-aware movement clamp:** views receive the current phase (new `setPhase(phase: MatchPhase)` on each view, called from the existing onStateChange — T5 wires one line); PLAY → current fast convergence; ALL other phases → per-frame movement clamped to `WALK_SPEED_M_S` (3 m/s) towards targets: everyone walks, nothing snaps. (The outcome hold gives the walk time to read.)
- **Batting bench (client choreography):** RunnersView (or a new small BenchView in the same file) renders the batting side's off-field characters seated at fixed bench spots (derive: a row outside LEGAL_ZONE.minX side near the batting end, spacing 2 m, from CONST — comment the layout); who's on the bench = batting squad ids minus current batter minus parked runners minus out-this-innings? OUT characters return to the bench seated (tint cleared after the dying animation). The current batter's figure originates at the bench and WALKS to the square when they become currentBatterId (the clamp does the walking); a dismissed batter's figure walks back (target = bench seat once the schema/running state drops them — reuse the retained-mesh machinery). Zero server data invented: derive strictly from squadIds/queueIds/currentBatterId/runners/playOutcome events.
- **Ball:** rotation from velocity (roll axis = up × v̂, rate = |v|/radius, in-air tumble damped); **highlight** = bright underglow disc billboard at ground projection + emissive pop; **trail** = ~12-point fading line-strip updated per frame while ballLive; **holder icon** = billboard sprite (painted canvas ball glyph) bobbing above the holder's head (drives off the existing hasBall flag) — plus the ball parks IN the hand sphere.
- [ ] Verify: whole client `tsc --noEmit` + eslint green (this closes T3's compile hold); quick Playwright smoke screenshot of a positioning scene (mascots render, no limbs missing) eyeballed. Controller commits T3 then T4 (or combined if T3 couldn't compile alone): `feat(client): minimal mascot characters` / `feat(client): walking world, bench choreography, ball presentation`.

---

### Task 5: Arcade-pop UI + tooltips + READY button + stadium/camera rescale (∥ T4 after T3)

**Files:** `client/index.html`, `client/src/UIModule.ts`, `client/src/DraftScreen.ts`, `client/src/SceneModule.ts`, `client/src/CameraControls.ts`, `client/src/main.ts`.

- **unslop-ui FIRST.** Arcade-pop identity: light/vibrant backgrounds, saturated primaries, thick outlines, chunky rounded cards, energetic banners; dark glass fully retires; team navy/maroon as accents. Re-group info: score strip (score/innings/outs/badges), batter+bowler cards, decluttered feed, action hints. Keep ids/classes stable.
- **Tooltips:** a styled tooltip mechanism (one absolutely-positioned div driven by mouseover on `[data-tip]` elements — cheap, no library); apply `data-tip` to stat abbreviations (draft rows), ability tags (full description text from a client-side `ABILITY_TEXT: Record<AbilityId, string>` map — write honest descriptions from the shared registry semantics), panel rows, READY button, legend camera hints.
- **READY button:** bottom-right `#ready-button`; visible in INITIAL_POSITIONING ('CONFIRM SETUP') and PRE_PLAY ('READY UP'); green idle → blue + ✓ + 'WAITING FOR OPPONENT' once sent (derive confirmed-state client-side: track that we sent for this phase instance; reset when phase changes — the server has no per-side confirm echo, so client-local latching is correct and honest); click AND Enter both fire the same net senders; hidden elsewhere; big, stylised, tooltip'd.
- **Stadium/camera for ×2:** SceneModule is CONST-driven — verify stands/boards/crowd/markings/sky rebuild sanely at ×2 (adjust the bowl radii derivation if it hardcoded margins); camera default pose rescales (pull back/up ~×2 — pick a framing showing the whole bigger field; update CLASSIC pose in BOTH SceneModule and CameraControls reset), orbit clamps rescale (radius ~24–110).
- **main.ts:** wire `setPhase` into the three/four views (one line each in onStateChange); READY button hookups; nothing else.
- [ ] Verify: typecheck/eslint; live smoke: restyled screens + tooltips hover screenshot + READY green→blue click-through on both pages; stadium frames the big field. Controller commits: `feat(client): arcade-pop UI, tooltips, ready button, x2 framing`.

---

### Task 6: Acceptance + docs

**Files:** `docs/superpowers/acceptance/readable-{acceptance,browser-acceptance}.{mjs,txt}` + `readable-0*.png`; CLAUDE.md §6; README (gallery + copy: field size, pacing, bench); TUNING.md (all new tunables).

- Scripted WS: full seeded game on the ×2 field — plays resolve in the 8–15 s band (measure + log distribution), no catch within 4 m of launch (roll/ball-state assert), a relay throw observed (seeded), outcome hold verified (fielder positions static for OUTCOME_HOLD_S after playOutcome then walk—er, snap server-side but the hold observed), missed-pitch respawn ≤ ~2 s, loft: launch elevation distribution logged (no 0° monoculture).
- Browser: arcade UI screenshots (lobby/draft/HUD/tooltips visible/READY green + blue-tick states), mascot lineup, ball trail+highlight mid-flight screenshot, holder icon screenshot, bench occupied + batter WALKING (two frames ~1 s apart showing progress, no jump), no >walk-speed movement outside PLAY (position sampling), zero console errors.
- Docs: §6.1 overwrite (the overhaul recorded; investigation-driven fixes named), §6.2 rows (×2 scaling decision + real speeds; catch arming; relay rule; outcome hold; loft sampling + draw-count change; client bench = pure presentation), §6.3 entry, §6.4 sweep (backstop instant-catch item CLOSED with evidence; teleport item CLOSED; update suite-runtime note — pacing makes it LONGER: measure and record). README + TUNING per spec. `npm run check` green ×2. Commit: `docs: readable-game overhaul acceptance evidence and project log`.

---

## Self-Review Notes (already applied)

- Spec A→T1, B→T1+T2, C→T4(+T5 wiring), D→T4, E→T3, F→T5, verification→T2/T6.
- The T3-can't-compile-alone hold is explicit (T3+T4 commit choreography); reviews stay separate.
- Draw-count change is deliberate and confined to T1 with the contract docs updated; T2 re-pins once.
- Outcome hold interacts with: pause (sim-time — safe), rematch (short-circuit — T1 must clear any pending finalisation in handleRematch), GAME_OVER (hold then finalise; result overlay unaffected — it keys off phase which flips at finalise: verify the overlay still appears — if the phase flip is what shows the overlay, holding delays it 1.5 s — acceptable, it IS the tableau).
- Bench derivation uses only synced state; a parked runner is NOT on the bench; the whale (undrafted) is never anywhere.
