# M8 Design — PositioningModule + positioning UI (spec §9.8, §4, §7)

Date: 2026-07-04. Status: USER-APPROVED (this session).
User decisions: **full substitution including UI** (bench renders empty until the roster grows —
chosen deliberately with roster growth planned); reposition = **click fielder, click ground** (3D
raycast); batter control = **choose next batter only** (no full order editor). Session finding
folded in: `BENCH_STAMINA_REGEN` is meaningless without cross-play stamina, so M8 introduces the
**persistent stamina ledger** (closes the §6.4 "stamina static within a play" item).

## 1. Contracts (/shared)

- `types.ts` gains `RepositionInput { id: string; x: number; z: number }`,
  `SubstituteInput { outId: string; inId: string }`, `SetBatterInput { id: string }` (§7 shapes).
- `constants.ts` FIELD gains: `LEGAL_ZONE: { minX, maxX, minZ, maxZ }` — a rectangle enclosing the
  placeholder field (all current FIELDING_POSITIONS and posts must lie inside; structural test
  pins that); `BATTING_SQUARE_KEEPOUT` — radius (m) around BATTING_SQUARE fielders must stay
  outside (tunable; suggest 3); `PITCHING_SPOT` — alias of `FIELDING_POSITIONS[0]` made explicit
  (the bowling square). Existing `SUBS_PER_INNINGS_CASUAL = Infinity` and
  `BENCH_STAMINA_REGEN = 1` are used, not redefined. M8 uses the CASUAL subs cap (ranked mode is
  future scope).

## 2. Server PositioningModule (new, pure — one instance per side)

`createPositioningModule(squad: Character[], fieldSlots: number)`:
- On-field = first `min(squad.length, fieldSlots)` characters in pick order, each with a default
  position (the FIELDING_POSITIONS slot layout); bench = the rest.
- `reposition(id, x, z): boolean` — false when: id not on-field; id is the current pitcher (the
  bowler moves only via `setPitcher`; the module takes `pitcherId` via a setter or parameter);
  `(x, z)` outside `LEGAL_ZONE`; or within `BATTING_SQUARE_KEEPOUT` of `BATTING_SQUARE`.
- `substitute(outId, inId): boolean` — false when: outId not on-field, inId not benched, or the
  per-innings cap (`SUBS_PER_INNINGS_CASUAL`) is spent. Success swaps them (inId inherits outId's
  position) and increments `subsUsed`.
- `view(): { positions: Record<string, { x: number; z: number }>; onField: string[]; bench: string[]; subsUsed: number }`.
- `resetSubs()` — called at innings change. Positions/bench PERSIST for the side across the whole
  game (your layout is yours); rematch resets to defaults (fresh modules).

## 3. Persistent stamina ledger (MatchRoom)

- `staminaById: Map<string, number>` seeded to stat stamina for every drafted character when the
  draft completes (and re-seeded on rematch).
- `rebuildFielding` seeds each FielderSetup's starting stamina from the ledger (FieldingModule
  gains an optional per-fielder initial-stamina input — smallest possible surface change).
- At every play end, the ledger absorbs the fielding module's current per-fielder stamina; every
  BENCHED character (either side) regains `BENCH_STAMINA_REGEN`, capped at stat stamina.
- Batting-side non-active characters count as benched for regen purposes; runner stamina remains
  static within a play (unchanged — only the ledger persists across plays).

## 4. MatchRoom wiring

| message | phase gate | role gate | payload gate |
|---|---|---|---|
| reposition | INITIAL_POSITIONING or PRE_PLAY | fielding side | module validation (prose reasons) |
| substitute | INITIAL_POSITIONING or PRE_PLAY | fielding side | module validation |
| setBatter | INITIAL_POSITIONING or PRE_PLAY | batting side | id in the remaining batting queue |

- All get the standard 'paused'-first check and 'wrongRole' exact reason; positions lock entering
  PLAY purely by the phase gates (spec §2).
- Applying reposition/substitute re-slots the live fielding layout: custom positions override the
  default slot map; the pitcher is ALWAYS at `PITCHING_SPOT`; a substituted-in fielder takes the
  outgoing fielder's position. `rebuildFielding` becomes layout-driven: positions come from the
  side's PositioningModule view, not the raw slot map (preserving its never-in-PLAY contract).
- `setBatter` → new pure `RulesModule.setNextBatter(id): boolean` (id in queue → moved to front).
- Schema additions: `benchA`/`benchB` (ArraySchema<string>), `subsUsedA`/`subsUsedB` (number).
  Positions continue to sync through the existing fielders MapSchema.
- Test-only room option `fieldSlotsOverride?: number` (runtime-validated like `seed`) restricts
  field slots so the 5-man squads yield a real bench in room tests/acceptance.

## 5. Client

- **Reposition:** during INITIAL_POSITIONING/PRE_PLAY, the fielding side clicks one of its own
  fielder capsules (raycast via the existing scene camera; selected capsule visually marked), then
  clicks the ground → `sendReposition({id, x, z})`. Clicking another fielder re-selects; Escape
  clears. Rejections surface on the status line as usual.
- **Panel:** DraftScreen's sheet gains a positioning mode for the fielding side — on-field rows
  (click = select for reposition, same selection state as the 3D pick), bench rows (with an
  on-field row selected, clicking a bench row sends `substitute`), sub count shown; bench renders
  even when empty with an explicit `bench — awaiting roster growth` note (user choice). Batting
  side sees its remaining queue rows (click = `setBatter`, current next marked). unslop-ui pass
  mandatory; same scorer's-sheet language.
- NetModule: `sendReposition`/`sendSubstitute`/`sendSetBatter` + new state fields.

## 6. Testing and acceptance (§9.8)

- PositioningModule unit tests: zone/keep-out/pitcher-guard rejections, default layout, sub swap +
  cap + bench membership, persistence semantics, resetSubs.
- RulesModule: setNextBatter (in-queue moves to front; out/current-batter/unknown rejected).
- Room integration: reposition moves the schema fielder (and survives readyForPlay → PLAY);
  illegal spots rejected with prose reasons; reposition in PLAY rejected; layout persists across
  an innings switch and returns intact next innings; `fieldSlotsOverride` room proves substitute
  end-to-end (bench swap visible in schema, cap enforced) and the stamina ledger (drained fielder
  comes back with lower stamina next innings; benched character regains).
- Acceptance: scripted WS run covering the matrix + persistence + a sub + ledger observation;
  Playwright: click-to-reposition on the real 3D scene (capsule select → ground click → capsule
  moved), subs panel visible with the empty-bench note, next-batter click changes the announced
  batter. Evidence under `docs/superpowers/acceptance/`.

## 7. Out of scope

- Batting-side substitution (queue-side swaps) — deferred to roster growth (logged decision).
- Full batting-order editor; ranked SUBS_PER_INNINGS = 3 mode selection; abilities (M9);
  legal-zone polygon beyond a rectangle (current field is a placeholder anyway).
