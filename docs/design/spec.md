# Carl Quest Sports — Technical Build Spec (for AI implementation)

This is an implementation spec. Build it exactly as written. Where a value is given, use that value. Where a formula is given, implement that formula. Stats are integers 1–10 unless stated.

---

## 0. Stack (use exactly this)

- **Language:** TypeScript (strict mode).
- **Rendering:** Three.js (r160+).
- **Physics:** Rapier (`@dimforge/rapier3d-compat`).
- **Networking:** Colyseus (server) + Colyseus.js (client). Server is authoritative.
- **Build:** Vite.
- **Runtime:** Node.js 20+ for server; browser (WebGL2) for client.

Monorepo layout:

```
/client        Three.js + Rapier client (rendering, input, prediction)
/server        Colyseus authoritative sim (Rapier headless, rules, scoring)
/shared        TS types, constants, stat formulas, character data (imported by both)
```

All game logic and physics run on the **server**. The client sends inputs and renders authoritative state. Client may run Rapier only for local visual prediction; the server result always wins.

---

## 1. Module Architecture

Build each as a separate module with the described interface.

### /shared

- **`types.ts`** — all shared interfaces (Character, Stat block, PlayerState, MatchState, network messages).
- **`characters.ts`** — the character roster data (§3) as a typed array.
- **`constants.ts`** — tunable numbers (§5, §6). One file, all magic numbers live here.
- **`formulas.ts`** — pure functions mapping stats → gameplay values (§5). No side effects.

### /server

- **`PhysicsModule`** — wraps Rapier world. Steps at fixed 60 Hz. Owns the ball rigid body, ground, post colliders. Exposes: `spawnBall()`, `applyPitch(params)`, `applyHit(params)`, `step(dt)`, `getBallState()`.
- **`PitchModule`** — converts pitcher stats + input into an initial ball velocity + angular velocity (spin). Feeds `PhysicsModule.applyPitch`.
- **`HitModule`** — resolves the batter swing: timing window vs ball, computes exit velocity, launch angle, and spin from Power/Spin/timing. Feeds `PhysicsModule.applyHit`.
- **`FieldingModule`** — controls fielder AI/movement, evaluates catches (Reach + Instinct + Reflex), and throws to posts. Resolves catch/no-catch each frame.
- **`RunningModule`** — moves batter-runners between posts by Speed, tracks who is on which post, resolves run-outs (ball-to-post vs runner arrival).
- **`RulesModule`** — rounders state machine: innings, outs, batting order, scoring (rounder / half-rounder), innings switch, game end. Single source of truth for match phase.
- **`PositioningModule`** — handles the pre-play phase (§4): repositioning, substitutions, pitcher/batter assignment. Validates legality, then locks positions when the play starts.
- **`DraftModule`** — alternating pick draft; removes picked characters from the shared pool.
- **`MatchRoom`** — Colyseus Room tying all modules together; owns the schema state, phase transitions, and message handlers.

### /client

- **`SceneModule`** — Three.js scene, pitch, posts, lighting, camera.
- **`RenderModule`** — syncs Three.js meshes to authoritative state each frame; interpolates.
- **`InputModule`** — captures pitch/swing/reposition/substitution inputs, sends to server.
- **`UIModule`** — lobby, draft screen, positioning screen, per-play control panel, HUD, result screen.
- **`NetModule`** — Colyseus.js connection, room join, message send/receive.

---

## 2. Match Phase State Machine (RulesModule)

Phases, in order, looping as noted:

1. `LOBBY` → both players connected → `DRAFT`.
2. `DRAFT` → alternating picks until both squads full → `INITIAL_POSITIONING`.
3. `INITIAL_POSITIONING` → both players confirm layout → `PRE_PLAY`.
4. `PRE_PLAY` → controlling side sets positions/subs/batter/pitcher, both confirm ready → `PLAY`.
5. `PLAY` → pitch thrown, ball live, resolves to a play outcome → `PLAY_RESOLVE`.
6. `PLAY_RESOLVE` → apply score/outs/runner state → if innings not over → `PRE_PLAY`; if all batters out → `INNINGS_SWITCH`.
7. `INNINGS_SWITCH` → swap batting/fielding sides → `PRE_PLAY`; if final innings complete → `GAME_OVER`.
8. `GAME_OVER` → show result → rematch resets to `INITIAL_POSITIONING`.

Positions **lock** on entering `PLAY` and unlock on entering `PRE_PLAY`.

---

## 3. Character Data (put in `characters.ts`)

Stat block type: `{ speed, reach, power, pitch, spin, stamina, reflex, instinct, nerve }`, all 1–10.

| id | name | spd | rch | pow | pit | spn | sta | rfx | ins | nrv | ability |
|----|------|-----|-----|-----|-----|-----|-----|-----|-----|-----|---------|
| carl | Carl | 7 | 6 | 8 | 5 | 5 | 7 | 6 | 6 | 8 | `CLUTCH_SWING` |
| kian | Kian | 5 | 6 | 5 | 8 | 9 | 6 | 7 | 6 | 6 | `CURVEBALL_MASTER` |
| laurie | Laurie | 6 | 9 | 6 | 5 | 5 | 7 | 7 | 8 | 6 | `LONG_REACH` |
| josh | Josh | 8 | 7 | 6 | 6 | 5 | 7 | 9 | 6 | 5 | `QUICK_DRAW` |
| joel | Joel | 6 | 6 | 7 | 9 | 6 | 6 | 6 | 5 | 6 | `CANNON_ARM` |
| darcy | Darcy | 7 | 7 | 7 | 6 | 7 | 7 | 7 | 7 | 7 | `SWITCH` |
| jonty | Jonty | 3 | 8 | 9 | 6 | 4 | 5 | 5 | 7 | 8 | `IMMOVABLE` |
| robbie | Robbie | 5 | 6 | 8 | 5 | 5 | 6 | 6 | 6 | 7 | `POWER_BASE` |
| joe | Joe | 2 | 2 | 2 | 3 | 2 | 3 | 2 | 2 | 2 | `BUTTERFINGERS` |
| ricy | Ricy | 7 | 8 | 8 | 8 | 6 | 8 | 7 | 7 | 7 | `POWERHOUSE` |
| whale | The Whale | 1 | 10 | 10 | 4 | 2 | 5 | 3 | 6 | 7 | `WALL` |

### Ability definitions (implement as modifiers in the relevant module)

- `CLUTCH_SWING` (HitModule): if `RulesModule.isFinalInnings`, effective Power +3.
- `CURVEBALL_MASTER` (PitchModule): spin curvature multiplier ×1.6 and curve onset delayed to last 40% of flight.
- `LONG_REACH` (FieldingModule): if fielder velocity ≈ 0, catch radius ×1.4.
- `QUICK_DRAW` (FieldingModule): throw-release delay after catch ×0.5.
- `CANNON_ARM` (PitchModule): pitch speed +3 effective Pitch; batter timing window ×0.85.
- `SWITCH` (HitModule): batter ignores opposing spin-read penalty; can mirror launch direction.
- `IMMOVABLE` (FieldingModule): catch success is guaranteed if ball enters catch radius (skip probability roll).
- `POWER_BASE` (HitModule): on well-timed contact (timing error < 0.1), Power +2.
- `BUTTERFINGERS` (FieldingModule): on every catch attempt in radius, 35% chance to fumble (drop) regardless of stats.
- `POWERHOUSE` (FieldingModule + PitchModule): catch radius +0.5 m; no stat penalties from fatigue until stamina < 2.
- `WALL` (FieldingModule): acts as a static blocker collider even when not catching; ball colliding with Whale stops dead.

---

## 4. PositioningModule — pre-play control (per play)

Before every `PLAY`, the controlling side(s) may, during `PRE_PLAY`:

- **Reposition** any owned on-field character to a new (x, z) within legal zones.
- **Substitute** an on-field character for a benched one.
- **Reassign** pitcher (fielding side) and next batter / batting order (batting side).

Validation rules (enforce server-side, reject illegal in `PositioningModule.validate`):

- Fielders must be inside the legal field polygon and outside the batting square.
- Batting side must have exactly one active batter at the batting square.
- Fielding side must have exactly one designated pitcher at the pitching spot.
- Substitution cap: `constants.SUBS_PER_INNINGS` (default `Infinity` casual, `3` ranked).
- Benched characters recover stamina at `constants.BENCH_STAMINA_REGEN` per play.

---

## 5. Stat → Gameplay Formulas (`formulas.ts`, pure functions)

Normalize stats to `s01 = stat / 10`. All outputs feed PhysicsModule.

**Movement speed (m/s):**
`moveSpeed = MOVE_MIN + (MOVE_MAX - MOVE_MIN) * s01(speed) * fatigueMult`

**Catch radius (m):**
`catchRadius = REACH_MIN + (REACH_MAX - REACH_MIN) * s01(reach)` (then apply ability mults)

**Pitch initial speed (m/s):**
`pitchSpeed = PITCH_MIN + (PITCH_MAX - PITCH_MIN) * s01(pitch)`

**Pitch spin (rad/s applied as angular velocity → Magnus curve):**
`pitchSpin = SPIN_MAX_RADS * s01(spin) * curveMult`

**Hit exit velocity (m/s):**
`exit = (HIT_MIN + (HIT_MAX - HIT_MIN) * s01(power)) * timingFactor`
where `timingFactor = clamp(1 - |timingError| / timingWindow, 0, 1)` and
`timingWindow = BASE_TIMING_WINDOW * (0.6 + 0.4 * s01(reflex))`.

**Hit launch spin:** `hitSpin = SPIN_MAX_RADS * s01(spin) * hitCurveMult`.

**Catch success probability (before ability overrides):**
`pCatch = clamp(BASE_CATCH + INSTINCT_W * s01(instinct) + REFLEX_W * s01(reflex) - approachPenalty, 0, 1)`

**Fatigue:** each sprint/throw drains stamina; `fatigueMult = stamina >= 3 ? 1 : 0.6 + 0.4 * (stamina/3)`.

**Nerve:** in high-pressure states (final innings OR runners on 2+ posts), apply `pressureMult = 0.85 + 0.15 * s01(nerve)` to timingFactor and pCatch.

---

## 6. PhysicsModule — Rapier config (`constants.ts`)

- Gravity: `(0, -9.81, 0)`.
- Fixed timestep: `1/60`. Server steps deterministically.
- Ball: sphere, radius `0.036 m`, mass `0.16 kg`, restitution `0.4`, linear damping `0.05`, angular damping `0.02`.
- **Magnus / spin curve:** each step apply lateral force `F = MAGNUS_K * cross(angularVel, linearVel)`, `MAGNUS_K = 0.0006` (tune). This is what makes spin throws/hits bend.
- Ground: static plane, friction `0.6`.
- Posts: static cylinder colliders; sensor volumes at each post for run-out detection.
- The Whale (WALL): static capsule collider active during fielding.

Suggested tunable ranges (place in constants, tune in playtest):
`MOVE_MIN 2.5, MOVE_MAX 8.0, REACH_MIN 0.8, REACH_MAX 3.0, PITCH_MIN 12, PITCH_MAX 30, HIT_MIN 10, HIT_MAX 40, SPIN_MAX_RADS 40, BASE_TIMING_WINDOW 0.25s, BASE_CATCH 0.3, INSTINCT_W 0.4, REFLEX_W 0.3`.

---

## 7. Networking (Colyseus)

**Room:** `MatchRoom`, `maxClients: 2`. Player 1 creates, Player 2 joins by room code.

**Schema state (synced):** phase, both squads (character id + live stats + stamina + field position), ball state (pos, vel, spin), score, innings, outs, current batter, current pitcher, runners-on-posts.

**Client→Server messages:** `draftPick(id)`, `confirmPositioning`, `reposition(charId, x, z)`, `substitute(outId, inId)`, `setPitcher(id)`, `setBatter(id)`, `readyForPlay`, `pitch(aimVec, spinInput)`, `swing(timing, aimVec, spinInput)`.

**Server→Client:** authoritative schema patches + `playOutcome(event)` (rounder, half-rounder, caught out, run out, no-ball).

Server validates every message against current phase; ignore/reject out-of-phase inputs.

---

## 8. Rounders Rules (RulesModule) — encode this variant

Implement school-rules rounders unless told otherwise:
- Bowling to the batter at the batting square.
- Batter hits into the field, then runs the posts.
- **Rounder** = complete circuit back to 4th post in one hit (full point). **Half-rounder** = reach a partial circuit / or when awarded by rule.
- **Outs:** caught out (ball caught before bounce), or ball delivered to the post ahead of the runner (run-out), or running inside a post.
- Innings ends when all batters on the batting side are out.
- Sides alternate; configurable number of innings (`INNINGS_COUNT`, default 2).
- Higher score at game end wins; tie → sudden-play tiebreak.

> If you want a different rounders variant (e.g. GAA), change only RulesModule scoring/out logic — the rest of the engine is variant-agnostic.

---

## 8b. Config values needing a decision (defaults given, safe to build with)

- `SQUAD_SIZE` = 9 field slots. `BENCH_SIZE` = configurable (default 2).
- `DRAFT_ROUNDS` = `SQUAD_SIZE + BENCH_SIZE` picks per player, alternating.
- `INNINGS_COUNT` = 2.
- `SUBS_PER_INNINGS` = Infinity (casual) / 3 (ranked).

---

## 9. Build Milestones (implement in this order)

1. Monorepo scaffold: /client (Three.js scene, pitch, posts, camera), /server (Colyseus empty room), /shared (types, constants).
2. PhysicsModule: Rapier world, ball, ground, Magnus spin curve. Test a pitched ball curves.
3. PitchModule + HitModule: single-player pitch→swing→ball flight loop vs a dummy batter.
4. FieldingModule + RunningModule: fielder chases, catches (stats-driven), throws to post; runner runs; run-out resolution.
5. RulesModule: full innings/outs/scoring state machine, single-player end-to-end.
6. MatchRoom + NetModule: 2-player authoritative sync over Colyseus.
7. DraftModule + draft UI.
8. PositioningModule + positioning UI + per-play reposition/substitution panel.
9. Wire abilities (§3) into their modules.
10. UIModule polish: lobby, HUD, result screen, rematch.

Deliver each milestone as runnable before starting the next.