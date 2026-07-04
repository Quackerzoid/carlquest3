# M7 Design — DraftModule + draft UI (spec §9.7, §1, §2, §7, §8b)

Date: 2026-07-04. Status: USER-APPROVED (this session).
User decisions this milestone: roster will GROW beyond 11 later — draft is generic over pool
size; with an odd/small pool, **5 picks each, 1 undrafted** (`picksEach = min(SQUAD_SIZE +
BENCH_SIZE, floor(poolSize / 2))` — at 22+ characters this becomes the spec's 9+2 automatically);
fielding map = **pick order verbatim** onto `FIELDING_POSITIONS` slots; **pitcher decision is
separate from pick order** — explicit `setPitcher(id)` pulled forward from M8, defaulting to the
fielding squad's highest pitch stat; draft UI = **clickable character cards** (mouse enters the
input vocabulary on this screen).

## 1. Contracts (/shared)

- `constants.ts` gains `DRAFT: { SQUAD_SIZE: 9, BENCH_SIZE: 2 }` (spec §8b values; structural
  pins in constants.test.ts). `DRAFT_ROUNDS` is NOT a constant — it is derived from the pool:
  `picksEach(poolSize) = min(SQUAD_SIZE + BENCH_SIZE, floor(poolSize / 2))`.
- `types.ts` gains `DraftPickInput { id: string }` and `SetPitcherInput { id: string }` (§7
  message shapes).

## 2. Server DraftModule (new, pure — the RulesModule pattern)

`createDraftModule(pool: Character[], picksEach: number)` →
- `view(): { turn: TeamSide | null; remainingIds: string[]; pickedA: string[]; pickedB: string[];
  complete: boolean }` — `turn` is null once complete; picked arrays are in pick order.
- `pick(side: TeamSide, id: string): boolean` — false when: not that side's turn, id unknown,
  already picked, or draft complete. True picks advance the strict alternation (spec §1
  "alternating pick"; side A = room creator picks first).
- `squads(): { squadA: Character[]; squadB: Character[] }` — resolved Character arrays in pick
  order (throws if not complete).
No timers, no snake order, no undo (YAGNI; casual game).

## 3. RulesModule interface change (deliberate, M7-scoped)

`completeDraft(squads?: { squadA: Character[]; squadB: Character[] })` — when provided, replaces
the construction-time squads before the DRAFT→INITIAL_POSITIONING transition (batting order =
array order = pick order, matching the existing RulesConfig contract). Bare `completeDraft()`
keeps the constructor squads, so the existing rules tests migrate with near-zero churn.

## 4. MatchRoom

- The M5/M6 mirror-roster auto-draft is deleted: second join → `bothConnected()` → the room now
  RESTS in DRAFT. `createDraftModule(CHARACTERS, picksEach(CHARACTERS.length))` at onCreate.
- New `draftPick` handler: reject 'paused'; phase must be DRAFT; sender's side must equal
  `draft.view().turn` (reason 'wrongRole'); `pick()` false → reject prose reason. On completion:
  `rules.completeDraft(draft.squads())` → INITIAL_POSITIONING, then build the innings-1 fielding
  side.
- New `setPitcher` handler: reject 'paused'; phase must be INITIAL_POSITIONING or PRE_PLAY
  (positions lock entering PLAY, spec §2); sender must be the CURRENT fielding side ('wrongRole');
  id must be in that side's squad (prose reject). Applies immediately: fielding layout re-slots
  and resyncs.
- **Fielding derivation is now per-side** (the mirror-roster invisibility ends): fielding squad =
  the non-batting side's drafted squad, mapped onto the first N `FIELDING_POSITIONS` slots in pick
  order, EXCEPT the current pitcher who takes slot 0 (the bowling square) with the others filling
  the remaining slots in pick order. Pitcher defaults to the fielding squad's highest pitch stat
  (ties: earlier pick wins) and resets to that default whenever the fielding side changes.
  FieldingModule + the `fielders` MapSchema are REBUILT whenever the fielding side or pitcher
  changes (innings switch, tiebreak entry, rematch, setPitcher) — never during PLAY.
- Schema additions (all client-renderable from synced state): `draftTurn: string` ('A'|'B'|''),
  `draftRemaining: ArraySchema<string>`, `squadAIds: ArraySchema<string>`, `squadBIds:
  ArraySchema<string>`. `currentPitcherId` already exists and stays authoritative.
- Rematch: same squads, draft NOT re-run (a rematch is a rematch, not a re-draft); pitcher resets
  to default.

## 5. Client draft screen + pitcher nomination

- Draft overlay in the lobby screen's visual language (unslop-ui pass at implementation): one card
  per character — name, 9-stat spread, ability tag. On YOUR turn (derived `mySide ===
  state.draftTurn`) unpicked cards are clickable → `sendDraftPick({id})`; picked cards grey out
  badged A/B; the undrafted leftover stays greyed unbadged when the draft completes. Overlay
  shows while phase === 'DRAFT'.
- Pitcher nomination: while phase is INITIAL_POSITIONING or PRE_PLAY and you are the fielding
  side, your own squad's cards remain clickable in a slim strip (same card component) →
  `sendSetPitcher({id})`; the current pitcher is marked. Hidden during PLAY.
- Status line: `DRAFT | your pick` / `DRAFT | opponent picks`, and `bowler: <name>` once live.
- NetModule: `sendDraftPick`, `sendSetPitcher`, plus the new state fields in `MatchStateView`.

## 6. Validation summary (server, all structured `rejected` — targeted delivery per M6)

| message | phase gate | role gate | payload gate |
|---|---|---|---|
| draftPick | DRAFT | sender side === draft turn | id in remaining pool |
| setPitcher | INITIAL_POSITIONING or PRE_PLAY | sender side === fielding side | id in own squad |

## 7. Testing and acceptance (§9.7)

- DraftModule unit tests: alternation, exclusivity, unknown/taken/out-of-turn rejections,
  completion at 2×picksEach, `picksEach` derivation (11 → 5; 22 → 11; 4 → 2), squads() order +
  throw-if-incomplete.
- Room integration (two clients): full draft to INITIAL_POSITIONING; squads reach RulesModule
  (first batter = A's first pick); out-of-turn/taken picks rejected 'wrongRole'/prose; default
  pitcher = highest pitch stat of side B's squad; setPitcher from batting side rejected, from
  fielding side re-slots (schema shows nominee at the bowling square) and is rejected during PLAY;
  after an innings switch the OTHER five take the field with THEIR default pitcher.
- Existing-test churn: room tests currently rely on the auto-draft — a shared test helper drafts
  a fixed 5/5 split to reach INITIAL_POSITIONING; the M5/M6 FIELDING_IDS-style expectations are
  re-derived from the drafted squads. Never weaken a gate.
- Acceptance: scripted 2-client WS run — full draft, a wrong-turn pick shown rejected, setPitcher
  shown applied, then at least one full innings each way on the drafted squads to prove the
  per-side fielding rebuild live. Browser (Playwright, two tabs): click through the whole draft,
  screenshot the grid mid-draft and complete. Evidence committed under
  `docs/superpowers/acceptance/`.

## 8. Out of scope

- Reposition/substitute messages, legal-zone validation, bench stamina regen (M8 — bench is empty
  at 11 characters anyway); abilities (M9); draft timers/snake order/re-draft on rematch (YAGNI);
  roster expansion itself (content, not engine — the draft already scales).
