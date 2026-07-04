# Milestone 7 — Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real alternating draft from the shared 11-character pool (5 picks each, 1 undrafted), per-side squads driving batting order and per-innings fielding, explicit pitcher nomination, and a clickable draft UI.

**Architecture:** New pure `DraftModule` (RulesModule pattern) owns pick bookkeeping; `RulesModule.completeDraft` gains an optional squads payload; MatchRoom replaces the mirror-roster auto-draft with a real DRAFT phase and derives the fielding setup per innings from the drafted squads (pitcher = explicit nomination, defaulting to highest pitch stat). Client renders the draft and pitcher choice from synced state as clickable cards.

**Tech Stack:** TypeScript strict, Colyseus 0.15 (`ArraySchema`), Vitest + @colyseus/testing, plain-DOM client.

**Design spec:** `docs/superpowers/specs/2026-07-04-m7-draft-design.md` — read before starting any task. NOTE one correction to its §1: `SQUAD_SIZE: 9` and `BENCH_SIZE: 2` ALREADY exist in `shared/src/constants.ts` under `GAME` (M1) — reuse them; add NO new constants.

## Global Constraints

- TypeScript strict; no `any`/`@ts-ignore` without a justifying comment. British English.
- Server authoritative; every message phase- AND role-validated; rejections use the M6 targeted `reject(client, message, reason)` with exact reasons `'wrongRole'`/`'paused'` (other reasons prose).
- All tunables in `shared/src/constants.ts`; no magic numbers.
- Verification per task: `npm run check` green (typecheck ×3, ESLint, full Vitest).
- Existing-test churn is REQUIRED (the auto-draft dies; fielding drops from 9 mirror fielders to the drafted five): update tests to the new protocol and re-derive expectations — NEVER weaken a gate or assertion to keep an old test green. Physics-dependent outcome tests may legitimately change outcome with 5 fielders; re-derive, don't delete, and document each re-derivation in the task report.
- Work in a worktree via superpowers:using-git-worktrees; concurrent implementers do NOT commit (controller serialises).
- Deterministic test draft order (used by helpers and acceptance): alternating picks straight down the CHARACTERS table → squad A = carl, laurie, joel, jonty, joe; squad B = kian, josh, darcy, robbie, ricy; whale undrafted. Handy facts: A's first batter = carl (unchanged from M5); B's default pitcher = kian (pitch 8, tie with ricy 8 broken by earlier pick — same bowler as the M5 demo); A's default pitcher (innings 2) = joel (pitch 9).

## File Structure

- Create: `server/src/modules/DraftModule.ts`, `server/test/DraftModule.test.ts`
- Modify: `shared/src/types.ts` (+`DraftPickInput`, `SetPitcherInput`) + `shared/test/types.test.ts`
- Modify: `server/src/modules/RulesModule.ts` (completeDraft squads param) + `server/test/RulesModule.test.ts`
- Modify: `server/src/rooms/MatchState.ts` (+draft fields), `server/src/rooms/MatchRoom.ts` (draft wiring, per-side fielding, setPitcher), `server/test/MatchRoom.test.ts`
- Modify: `client/src/NetModule.ts`, `client/src/main.ts`, `client/index.html` (+`client/src/DraftScreen.ts` new — keep main.ts from bloating; one clear responsibility: card grid + pitcher strip DOM)
- Create: `docs/superpowers/acceptance/m7-*` (Task 5)

**Sequencing:** Task 1 ∥ Task 2 (disjoint files) → Task 3 ∥ Task 4 (server vs client) → Task 5.

---

### Task 1: Shared message types + pure DraftModule

**Files:**
- Modify: `shared/src/types.ts`, `shared/test/types.test.ts`
- Create: `server/src/modules/DraftModule.ts`
- Test: `server/test/DraftModule.test.ts`

**Interfaces:**
- Consumes: `Character`, `TeamSide` from `@carlquest/shared`; `CONST.GAME.SQUAD_SIZE`/`BENCH_SIZE`.
- Produces (Tasks 3–4 rely on these exact names): `DraftPickInput { id: string }`, `SetPitcherInput { id: string }` (shared); `picksEach(poolSize: number): number`; `createDraftModule(pool: Character[], picks: number)` → `{ view(): DraftView; pick(side: TeamSide, id: string): boolean; squads(): { squadA: Character[]; squadB: Character[] } }`; `DraftView { turn: TeamSide | null; remainingIds: string[]; pickedA: string[]; pickedB: string[]; complete: boolean }`.

- [ ] **Step 1: Shared types.** In `shared/src/types.ts` next to the other §7 message shapes:

```typescript
/** §7 draftPick message: the character the current picker takes. */
export interface DraftPickInput {
  id: string;
}

/** §7 setPitcher message (pulled forward from M8): the fielding side's nominated bowler. */
export interface SetPitcherInput {
  id: string;
}
```

Add to `shared/test/types.test.ts` (structural pins, matching that file's existing style): a `DraftPickInput` and a `SetPitcherInput` literal assignment test.

- [ ] **Step 2: Write the failing DraftModule tests** (`server/test/DraftModule.test.ts`):

```typescript
import { describe, expect, it } from 'vitest';
import { CHARACTERS, CONST } from '@carlquest/shared';
import { createDraftModule, picksEach } from '../src/modules/DraftModule';

describe('picksEach', () => {
  it('caps at SQUAD_SIZE + BENCH_SIZE and floors odd pools', () => {
    const cap = CONST.GAME.SQUAD_SIZE + CONST.GAME.BENCH_SIZE;
    expect(picksEach(11)).toBe(5); // today's roster: 5 each, 1 undrafted
    expect(picksEach(22)).toBe(cap); // spec's 9+2 once the roster is big enough
    expect(picksEach(4)).toBe(2);
    expect(picksEach(1)).toBe(0); // degenerate pool: nothing to draft
  });
});

describe('DraftModule', () => {
  const pick5 = () => createDraftModule([...CHARACTERS], picksEach(CHARACTERS.length));

  it('alternates strictly, side A first', () => {
    const draft = pick5();
    expect(draft.view().turn).toBe('A');
    expect(draft.pick('B', 'kian')).toBe(false); // out of turn
    expect(draft.pick('A', 'carl')).toBe(true);
    expect(draft.view().turn).toBe('B');
    expect(draft.pick('A', 'laurie')).toBe(false); // still out of turn
    expect(draft.pick('B', 'kian')).toBe(true);
    expect(draft.view().turn).toBe('A');
  });

  it('rejects unknown and already-picked ids without consuming the turn', () => {
    const draft = pick5();
    expect(draft.pick('A', 'nobody')).toBe(false);
    expect(draft.pick('A', 'carl')).toBe(true);
    expect(draft.pick('B', 'carl')).toBe(false); // taken
    expect(draft.view().turn).toBe('B'); // failed picks did not advance the turn
  });

  it('completes at 2 x picksEach with the leftover undrafted, then refuses picks', () => {
    const draft = pick5();
    const order = CHARACTERS.map((c) => c.id); // table order → deterministic test draft
    for (let i = 0; i < 10; i += 1) {
      const side = i % 2 === 0 ? 'A' : 'B';
      expect(draft.pick(side, order[i] ?? '')).toBe(true);
    }
    const v = draft.view();
    expect(v.complete).toBe(true);
    expect(v.turn).toBeNull();
    expect(v.remainingIds).toEqual(['whale']); // the undrafted leftover stays visible
    expect(draft.pick('A', 'whale')).toBe(false);
  });

  it('squads() returns Characters in pick order, and throws while incomplete', () => {
    const draft = pick5();
    expect(() => draft.squads()).toThrow();
    const order = CHARACTERS.map((c) => c.id);
    for (let i = 0; i < 10; i += 1) draft.pick(i % 2 === 0 ? 'A' : 'B', order[i] ?? '');
    const { squadA, squadB } = draft.squads();
    expect(squadA.map((c) => c.id)).toEqual(['carl', 'laurie', 'joel', 'jonty', 'joe']);
    expect(squadB.map((c) => c.id)).toEqual(['kian', 'josh', 'darcy', 'robbie', 'ricy']);
  });

  it('a zero-pick draft is complete immediately (turn null from the start)', () => {
    const draft = createDraftModule([CHARACTERS[0] ?? (() => { throw new Error('empty roster'); })()], picksEach(1));
    expect(draft.view().complete).toBe(true);
    expect(draft.view().turn).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure** — from `/server`: `npx vitest run test/DraftModule.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `server/src/modules/DraftModule.ts`:

```typescript
import { CONST, type Character, type TeamSide } from '@carlquest/shared';

export interface DraftView {
  /** Side to pick next; null once the draft is complete (or nothing to draft). */
  turn: TeamSide | null;
  /** Unpicked ids, pool order — after completion these are the undrafted leftovers. */
  remainingIds: string[];
  /** Picked ids in pick order (batting order = pick order downstream). */
  pickedA: string[];
  pickedB: string[];
  complete: boolean;
}

/**
 * Picks per player for a pool of the given size: the spec's DRAFT_ROUNDS
 * (SQUAD_SIZE + BENCH_SIZE) capped by what a shared exclusive pool can supply
 * (design decision: even squads, leftovers undrafted — 11 chars → 5 each).
 */
export function picksEach(poolSize: number): number {
  return Math.min(CONST.GAME.SQUAD_SIZE + CONST.GAME.BENCH_SIZE, Math.floor(poolSize / 2));
}

/**
 * Pure alternating draft (spec §1): side A (room creator) picks first, strict
 * A/B alternation, picked characters leave the shared pool. No timers, no
 * snake order, no undo — casual game, YAGNI.
 */
export function createDraftModule(
  pool: Character[],
  picks: number,
): {
  view(): DraftView;
  pick(side: TeamSide, id: string): boolean;
  squads(): { squadA: Character[]; squadB: Character[] };
} {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const remaining = new Set(byId.keys());
  const picked: Record<TeamSide, string[]> = { A: [], B: [] };
  let turn: TeamSide | null = picks > 0 ? 'A' : null;

  function complete(): boolean {
    return picked.A.length >= picks && picked.B.length >= picks;
  }

  function view(): DraftView {
    return {
      turn,
      remainingIds: [...remaining],
      pickedA: [...picked.A],
      pickedB: [...picked.B],
      complete: complete(),
    };
  }

  function pick(side: TeamSide, id: string): boolean {
    if (turn === null || side !== turn) return false;
    if (!remaining.has(id)) return false;
    remaining.delete(id);
    picked[side].push(id);
    turn = complete() ? null : side === 'A' ? 'B' : 'A';
    return true;
  }

  function squads(): { squadA: Character[]; squadB: Character[] } {
    if (!complete()) throw new Error('draft not complete');
    const resolve = (ids: string[]): Character[] =>
      ids.map((id) => {
        const c = byId.get(id);
        if (c === undefined) throw new Error(`unknown character ${id}`);
        return c;
      });
    return { squadA: resolve(picked.A), squadB: resolve(picked.B) };
  }

  return { view, pick, squads };
}
```

- [ ] **Step 5: Run green** — `npx vitest run test/DraftModule.test.ts` (all pass) and from `/shared`: `npx vitest run` (types pins pass).

- [ ] **Step 6: `npm run check`** at repo root green. Controller commits: `feat(server): pure DraftModule + shared draft message types`.

---

### Task 2: RulesModule.completeDraft(squads?)

**Files:**
- Modify: `server/src/modules/RulesModule.ts:186-190` (completeDraft), `server/test/RulesModule.test.ts`

**Interfaces:**
- Produces: `completeDraft(squads?: { squadA: Character[]; squadB: Character[] }): boolean` — when squads are given AND the transition fires, `squadIds` (batting orders) are replaced before INITIAL_POSITIONING; bare calls keep the constructor squads. Task 3 relies on this exact signature.

- [ ] **Step 1: Write the failing test** (append to `server/test/RulesModule.test.ts`, matching its construction style — it builds squads from CHARACTERS):

```typescript
describe('completeDraft with drafted squads (M7)', () => {
  it('replaces the constructor squads so batting order = pick order', () => {
    const rules = createRulesModule({ squadA: [...CHARACTERS], squadB: [...CHARACTERS] });
    rules.bothConnected();
    const squadA = ['laurie', 'carl', 'joel'].map((id) => CHARACTERS.find((c) => c.id === id)!);
    const squadB = ['ricy', 'kian', 'josh'].map((id) => CHARACTERS.find((c) => c.id === id)!);
    expect(rules.completeDraft({ squadA, squadB })).toBe(true);
    rules.confirmPositioning();
    rules.readyForPlay();
    expect(rules.view().currentBatterId).toBe('laurie'); // A's FIRST PICK bats first, not the table order
  });

  it('does not replace squads when the transition is refused (wrong phase)', () => {
    const rules = createRulesModule({ squadA: [...CHARACTERS], squadB: [...CHARACTERS] });
    const squadA = [CHARACTERS[1]!];
    const squadB = [CHARACTERS[2]!];
    expect(rules.completeDraft({ squadA, squadB })).toBe(false); // still LOBBY
    rules.bothConnected();
    rules.completeDraft();
    rules.confirmPositioning();
    rules.readyForPlay();
    expect(rules.view().currentBatterId).toBe(CHARACTERS[0]?.id ?? ''); // constructor order intact
  });
});
```

(Non-null `!` here is test-file convention for known-roster lookups — keep the justifying comment style used elsewhere in the file if it annotates these.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/RulesModule.test.ts -t 'completeDraft with drafted'`. Expected: FAIL (signature takes no argument / batter is table order).

- [ ] **Step 3: Implement.** Replace `completeDraft` in `server/src/modules/RulesModule.ts`:

```typescript
  function completeDraft(squads?: { squadA: Character[]; squadB: Character[] }): boolean {
    if (phase !== 'DRAFT') return false;
    if (squads !== undefined) {
      // M7: the real draft replaces the construction-time squads at the moment
      // the DRAFT phase closes (batting order = array order = pick order).
      squadIds.A = squads.squadA.map((c) => c.id);
      squadIds.B = squads.squadB.map((c) => c.id);
    }
    phase = 'INITIAL_POSITIONING';
    return true;
  }
```

`squadIds` arrays are currently built in the const initialiser — assignment to `.A`/`.B` properties of the const Record is legal; also update the exported return-type annotation on `createRulesModule` (line ~55) to the new signature. `Character` is already imported (RulesConfig uses it).

- [ ] **Step 4: Run green** — `npx vitest run test/RulesModule.test.ts` (existing 22 + 2 new). Then `npm run check` green. Controller commits: `feat(server): completeDraft accepts drafted squads`.

---

### Task 3: MatchRoom — real DRAFT phase, per-side fielding, setPitcher

**Files:**
- Modify: `server/src/rooms/MatchState.ts`, `server/src/rooms/MatchRoom.ts`
- Test: `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: Task 1's `createDraftModule`/`picksEach`/`DraftPickInput`/`SetPitcherInput`; Task 2's `completeDraft(squads?)`; existing `sideOf`, `fieldingSide()`, `reject(client, message, reason)`, `paused` checks, `confirmed`/`ready` gates.
- Produces (Task 4/5 rely on): schema fields `draftTurn: string` ('A'|'B'|''), `draftRemaining: ArraySchema<string>`, `squadAIds: ArraySchema<string>`, `squadBIds: ArraySchema<string>`; messages `draftPick` (DRAFT only, current picker only) and `setPitcher` (INITIAL_POSITIONING|PRE_PLAY, fielding side only, own-squad id); `currentPitcherId` always the live bowler; the fielding side's squad on the field each innings (pitcher slot 0, rest pick order).

- [ ] **Step 1: Schema.** Add to `MatchState` (new M7 section) and import `ArraySchema` from `@colyseus/schema`:

```typescript
  // --- M7 draft ---------------------------------------------------------------
  /** Side to pick next during DRAFT ('A'|'B'), '' once complete / before DRAFT. */
  @type('string') draftTurn = '';
  /** Unpicked character ids (pool order); after the draft these are the undrafted leftovers. */
  @type(['string']) draftRemaining = new ArraySchema<string>();
  /** Drafted squads in pick order (batting order). Empty until the draft completes... populated per pick. */
  @type(['string']) squadAIds = new ArraySchema<string>();
  @type(['string']) squadBIds = new ArraySchema<string>();
```

- [ ] **Step 2: Write the failing room tests** (new `describe('M7 draft', ...)`). Shared helper FIRST — a deterministic table-order draft used by every phase-walking test:

```typescript
/** Deterministic test draft: alternating picks straight down the CHARACTERS table.
 * A: carl, laurie, joel, jonty, joe · B: kian, josh, darcy, robbie, ricy · whale undrafted. */
async function draftSquads(room: TestRoom, clientA: TestClient, clientB: TestClient): Promise<void> {
  if (room.state.phase !== 'DRAFT') return; // already drafted (or pre-lobby — callers wait first)
  const order = CHARACTERS.map((c) => c.id);
  for (let i = 0; i < 10; i += 1) {
    const picker = i % 2 === 0 ? clientA : clientB;
    picker.send('draftPick', { id: order[i] ?? '' });
    await waitForCondition(room, () => room.state.squadAIds.length + room.state.squadBIds.length > i);
  }
  await waitForPhase(room, 'INITIAL_POSITIONING');
}
```

New tests:

```typescript
describe('M7 draft', () => {
  it('rests in DRAFT after both join, alternates picks A first, and completes to INITIAL_POSITIONING', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    expect(room.state.draftTurn).toBe('A');
    expect(room.state.draftRemaining.length).toBe(CHARACTERS.length);
    // Out of turn: B may not open the draft.
    clientB.send('draftPick', { id: 'kian' });
    await waitForCondition(room, () => room.state.lastRejection !== '');
    expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
    await draftSquads(room, clientA, clientB);
    expect([...room.state.squadAIds]).toEqual(['carl', 'laurie', 'joel', 'jonty', 'joe']);
    expect([...room.state.squadBIds]).toEqual(['kian', 'josh', 'darcy', 'robbie', 'ricy']);
    expect([...room.state.draftRemaining]).toEqual(['whale']);
    expect(room.state.currentPitcherId).toBe('kian'); // B fields first; highest pitch, tie → earlier pick
    expect(room.state.fielders.size).toBe(5); // the drafted five, not the M5 mirror nine
  });

  it('rejects a taken pick and a pick outside DRAFT', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    clientA.send('draftPick', { id: 'carl' });
    await waitForCondition(room, () => room.state.squadAIds.length === 1);
    clientB.send('draftPick', { id: 'carl' }); // taken
    await waitForCondition(room, () => room.state.lastRejection.includes('draftPick'));
    expect(JSON.parse(room.state.lastRejection).reason).not.toBe('wrongRole'); // prose reason, right role
    await draftSquads(room, clientA, clientB); // finish from the current state? see note below
  });

  it('setPitcher: fielding side re-slots its bowler; batting side and PLAY-phase attempts rejected', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    // A bats first, so B is the fielding side in INITIAL_POSITIONING.
    clientA.send('setPitcher', { id: 'joel' });
    await waitForCondition(room, () => room.state.lastRejection.includes('setPitcher'));
    expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
    clientB.send('setPitcher', { id: 'ricy' });
    await waitForCondition(room, () => room.state.currentPitcherId === 'ricy');
    const ricy = room.state.fielders.get('ricy');
    expect(ricy?.x).toBe(CONST.FIELD.FIELDING_POSITIONS[0]?.x); // nominee took the bowling square
    expect(ricy?.z).toBe(CONST.FIELD.FIELDING_POSITIONS[0]?.z);
    clientB.send('setPitcher', { id: 'carl' }); // not in B's squad
    await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason !== 'wrongRole');
    await startPlay(room, clientA, clientB);
    clientB.send('setPitcher', { id: 'kian' }); // positions locked in PLAY
    await waitForCondition(room, () => room.state.lastRejection.includes('only allowed'));
    expect(room.state.currentPitcherId).toBe('ricy');
  });

  it('after an innings switch the OTHER five field with THEIR default pitcher', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_CATCH });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    // ALWAYS_CATCH: every hit is caught pre-bounce → 5 outs ends A's innings quickly.
    // Loop plays until battingSide flips to 'B'.
    while (room.state.battingSide === 'A' && room.state.phase !== 'GAME_OVER') {
      await startPlay(room, clientA, clientB);
      await pitchThenSwing(room, clientA, clientB, { x: 0.55, y: 0.47, z: 0.65 });
      await waitForCondition(room, () => room.state.phase !== 'PLAY');
    }
    expect(room.state.battingSide).toBe('B');
    expect(room.state.currentPitcherId).toBe('joel'); // A fields now; joel has A's best arm (pitch 9)
    expect(room.state.fielders.size).toBe(5);
    expect([...room.state.fielders.keys()].sort()).toEqual(['carl', 'joe', 'joel', 'jonty', 'laurie']);
  });
});
```

(Adapt the innings-switch loop to the file's existing full-game test patterns — reuse their helpers if a tighter idiom exists. The `draftSquads` mid-file call in the taken-pick test must resume from partial state: generalise the helper to skip already-picked ids, or draft explicitly there.)

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/MatchRoom.test.ts -t 'M7 draft'`. Expected: FAIL (phase races through DRAFT; no draftPick handler).

- [ ] **Step 4: Implement in MatchRoom.ts.**

4a. DELETE the module-scope `OPENER_ID` / `FIELDING_NINE` / `PITCHER_ID` block (lines 25–47) and its doc comment. Add imports: `createDraftModule, picksEach` from `../modules/DraftModule`; `type Character, type DraftPickInput, type SetPitcherInput` from `@carlquest/shared`; `ArraySchema` is only needed in MatchState.

4b. New fields + helpers:

```typescript
  private draft!: ReturnType<typeof createDraftModule>;
  /** Drafted squads (pick order), set when the draft completes; empty before. */
  private squads: Record<TeamSide, Character[]> = { A: [], B: [] };
  /** The nominated bowler for the CURRENT fielding side (default: best pitch stat). */
  private pitcherId = '';
  /** Fielding side the current FieldingModule was built for (rebuild on change). */
  private builtFieldingSide: TeamSide | null = null;
  /** Fielding deps captured once in onCreate so rebuilds reuse the same validated rng. */
  private fieldingRng!: () => number;

  /** Highest pitch stat wins; ties go to the earlier pick (array order). */
  private defaultPitcherId(squad: Character[]): string {
    let best: Character | undefined;
    for (const c of squad) if (best === undefined || c.stats.pitch > best.stats.pitch) best = c;
    return best?.id ?? '';
  }

  private fieldingDeps() {
    return {
      rng: this.fieldingRng,
      hasBounced: () => this.physics.hasBounced(),
      applyThrow: (params: Parameters<PhysicsModule['applyPitch']>[0]) => this.physics.applyPitch(params),
      holdBallAt: (pos: Parameters<PhysicsModule['spawnBall']>[0]) => this.physics.spawnBall(pos),
      pressure: () => this.rules.pressure(this.runnersOnPosts()),
    };
  }

  /**
   * (Re)build the fielding side from the drafted squads: nominated pitcher on
   * slot 0 (the bowling square), the rest in pick order on the remaining
   * FIELDING_POSITIONS. Called when the draft completes, when the fielding side
   * changes (innings switch / tiebreak / rematch — pitcher resets to default),
   * and on setPitcher. Never during PLAY (callers guarantee it).
   */
  private rebuildFielding(): void {
    const side = this.fieldingSide();
    const squad = this.squads[side];
    if (squad.length === 0) return; // draft not complete yet
    if (this.builtFieldingSide !== side) {
      this.pitcherId = this.defaultPitcherId(squad);
      this.builtFieldingSide = side;
    }
    const ordered = [
      ...squad.filter((c) => c.id === this.pitcherId),
      ...squad.filter((c) => c.id !== this.pitcherId),
    ];
    const setup: FielderSetup[] = ordered.slice(0, FIELD.FIELDING_POSITIONS.length).map((character, i) => {
      const position = FIELD.FIELDING_POSITIONS[i];
      if (position === undefined) throw new RangeError(`no fielding slot ${i}`);
      return { character, position };
    });
    this.fielding = createFieldingModule(setup, this.fieldingDeps());
    this.state.fielders.clear();
    this.state.currentPitcherId = this.pitcherId;
    this.syncFielders();
  }

  private syncDraft(): void {
    const v = this.draft.view();
    this.state.draftTurn = v.turn ?? '';
    this.state.draftRemaining.splice(0, this.state.draftRemaining.length, ...v.remainingIds);
    this.state.squadAIds.splice(0, this.state.squadAIds.length, ...v.pickedA);
    this.state.squadBIds.splice(0, this.state.squadBIds.length, ...v.pickedB);
  }
```

4c. onCreate changes: keep the placeholder `createRulesModule({ squadA: [...CHARACTERS], squadB: [...CHARACTERS] })` (replaced at completeDraft); store `this.fieldingRng = rng;`; REPLACE the `createFieldingModule(FIELDING_NINE, ...)` call with an EMPTY module so `fielding` is never null pre-draft:

```typescript
    this.fielding = createFieldingModule([], this.fieldingDeps()); // placeholder until the draft completes
    this.draft = createDraftModule([...CHARACTERS], picksEach(CHARACTERS.length));
```

Delete `this.state.currentPitcherId = PITCHER_ID;`. Add `this.syncDraft();` next to the other initial syncs. Register the two new handlers:

```typescript
    this.onMessage('draftPick', (client, message) => this.handleDraftPick(client, message));
    this.onMessage('setPitcher', (client, message) => this.handleSetPitcher(client, message));
```

4d. onJoin second-seat branch: replace `this.rules.bothConnected(); this.rules.completeDraft();` with just `this.rules.bothConnected();` — the room now rests in DRAFT.

4e. Handlers:

```typescript
  private handleDraftPick(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'draftPick', 'paused');
      return;
    }
    if (this.phase() !== 'DRAFT') {
      this.reject(client, 'draftPick', `only allowed in DRAFT (phase ${this.phase()})`);
      return;
    }
    const side = this.sideOf(client);
    if (side === null || side !== this.draft.view().turn) {
      this.reject(client, 'draftPick', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<DraftPickInput>;
    if (typeof m.id !== 'string' || !this.draft.pick(side, m.id)) {
      this.reject(client, 'draftPick', 'unknown or already-picked character');
      return;
    }
    this.syncDraft();
    if (this.draft.view().complete) {
      const squads = this.draft.squads();
      this.squads = { A: squads.squadA, B: squads.squadB };
      this.rules.completeDraft(squads);
      this.rebuildFielding(); // innings 1: side B fields, default pitcher
      this.syncRulesView();
    }
  }

  private handleSetPitcher(client: Client, message: unknown): void {
    if (this.state.paused) {
      this.reject(client, 'setPitcher', 'paused');
      return;
    }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'setPitcher', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject(client, 'setPitcher', 'wrongRole');
      return;
    }
    const m = asRecord(message) as Partial<SetPitcherInput>;
    const squad = this.squads[this.fieldingSide()];
    if (typeof m.id !== 'string' || !squad.some((c) => c.id === m.id)) {
      this.reject(client, 'setPitcher', 'not in your squad');
      return;
    }
    this.pitcherId = m.id;
    this.rebuildFielding();
  }
```

4f. Fielding-side change hooks — in `endPlay`, after the existing `syncRulesView()` at the end, add `this.rebuildFielding();` (it no-ops unless the side changed — `builtFieldingSide` guard — and endPlay never runs during PLAY's live flight... it runs AT play end, which is exactly when PRE_PLAY begins, so safe). In `handleRematch`, replace `this.fielding.reset()` with `this.builtFieldingSide = null; this.rebuildFielding();` (forces the innings-1 fielding side + default pitcher). NOTE: `endPlay`'s existing `this.fielding.reset()` stays for the same-side case (rebuild replaces the module only on side change).

- [ ] **Step 5: Migrate existing tests.** Every phase-walking test now hits DRAFT: extend `startPlay(room, clientA, clientB)` to call `await draftSquads(room, clientA, clientB)` when `room.state.phase === 'DRAFT'` (after its LOBBY wait). Update the M5/M6 expectation constants: `FIELDING_IDS` (mirror nine) is replaced by the drafted-five facts in Global Constraints; fielder-count assertions 9 → 5; any test aiming a hit AT a specific fielder re-derives against the five-fielder layout (kian still bowls from slot 0, so bowler-catch tests likely hold). Physics-outcome tests that change outcome with 5 fielders: re-derive the assertion from a fresh run's behaviour ONLY when the new behaviour is legitimately correct (document each in the report); never simply widen a tolerance.

- [ ] **Step 6: Run the full file** — `npx vitest run test/MatchRoom.test.ts` all green, then `npm run check` green. Controller commits: `feat(server): real draft phase, per-side fielding rebuild, setPitcher`.

---

### Task 4: Client — draft screen, pitcher nomination, senders (parallel with Task 3)

**Files:**
- Create: `client/src/DraftScreen.ts`
- Modify: `client/src/NetModule.ts`, `client/src/main.ts`, `client/index.html`

**Interfaces:**
- Consumes: Task 1's `DraftPickInput`/`SetPitcherInput` types; Task 3's schema fields BY NAME (`draftTurn: string`, `draftRemaining`, `squadAIds`, `squadBIds` — array-schema values; extend `MatchStateView` with `draftTurn: string` and the three as `ReadonlyArray<string>`-compatible (`ArraySchema` supports length/index/iteration — type them `readonly string[]` and read defensively while the server task is in flight).
- Produces: `Net.sendDraftPick(input: DraftPickInput)`, `Net.sendSetPitcher(input: SetPitcherInput)`; `createDraftScreen(container, deps)` (below).

**UI note:** MANDATORY — invoke the `anthropic-skills:unslop-ui` skill BEFORE writing the card styles; extend the existing lobby aesthetic (monospace, parchment `#f5f1e6`, hairline borders, single accent, no gradients/shadows/emoji). Cards must read as a scorer's roster sheet, not a trading-card template.

- [ ] **Step 1: NetModule.** Extend `MatchStateView` with `draftTurn: string; draftRemaining: readonly string[]; squadAIds: readonly string[]; squadBIds: readonly string[];` and `Net` with:

```typescript
  sendDraftPick(input: DraftPickInput): void;   // room.send('draftPick', input)
  sendSetPitcher(input: SetPitcherInput): void; // room.send('setPitcher', input)
```

- [ ] **Step 2: DraftScreen module** (`client/src/DraftScreen.ts`) — one responsibility: the card grid + pitcher strip DOM. Exact shape:

```typescript
import { CHARACTERS, type Character } from '@carlquest/shared';
import type { MatchStateView, Net } from './NetModule';

export interface DraftScreen {
  /** Re-render from synced state; call on every onStateChange. Cheap (11 cards). */
  update(state: MatchStateView, mySide: 'A' | 'B' | null): void;
}

/**
 * Renders (a) the DRAFT-phase pick grid — one card per roster character, clickable
 * on your turn, greyed + side-badged once picked, leftover stays greyed unbadged —
 * and (b) the pitcher strip during INITIAL_POSITIONING/PRE_PLAY for the fielding
 * side: your squad's cards, current bowler marked, click to nominate.
 */
export function createDraftScreen(container: HTMLElement, net: Net): DraftScreen { ... }
```

Implementation requirements (write real code, this signature is binding): build all cards once from `CHARACTERS` (name, the 9 stats as a compact `spd 7 · rch 6 · …` line, ability tag); on `update`, derive per-card state from `state.draftRemaining`/`squadAIds`/`squadBIds`/`draftTurn`/`phase`/`battingSide` + `mySide`; container visible when `phase === 'DRAFT'` OR (phase is INITIAL_POSITIONING/PRE_PLAY AND mySide is the fielding side — battingSide !== mySide — showing ONLY your squad as the pitcher strip with `state.currentPitcherId` marked); clicks send `sendDraftPick`/`sendSetPitcher` per mode; never trust click state — the server revalidates.

- [ ] **Step 3: index.html + main.ts.** Add `<div id="draft" hidden></div>` (styled in the unslop-ui pass; overlay like `#lobby` but non-blocking of the status line). In `main.ts`: query + rebind `#draft`, `const draftScreen = createDraftScreen(draftEl, net)` inside `runMatch` (per-net, like attachInput — it holds the net closure; the container is emptied on each createDraftScreen call so re-entry after opponentLeft is clean), call `draftScreen.update(state, net.mySide())` inside the existing `onStateChange` handler, and extend `statusLine` with a DRAFT segment: when `phase === 'DRAFT'`, `state.draftTurn === net.mySide() ? 'your pick' : 'opponent picks'`; once live, append `bowler: ${characterName(state.currentPitcherId)}`.

- [ ] **Step 4: Verify.** From `/client`: `npx tsc --noEmit -p tsconfig.json`; repo root: `npx eslint client/src`. Both clean. Live behaviour is proven in Task 5. Controller commits: `feat(client): draft screen with clickable cards + pitcher nomination`.

---

### Task 5: §9.7 acceptance + docs

**Files:**
- Create: `docs/superpowers/acceptance/m7-acceptance.mjs`, `m7-acceptance.txt`, `m7-browser-acceptance.mjs`, `m7-0*.png`
- Modify: `CLAUDE.md` §6, `TUNING.md` (only if a tunable emerged)

**Interfaces:** consumes everything above; produces committed evidence. Patterns: `docs/superpowers/acceptance/m6-acceptance.mjs` (WS harness incl. code join) and `m6-browser-acceptance.mjs` (Playwright two-page).

- [ ] **Step 1: Scripted WS acceptance** vs a real `npm run dev` server: create+join by code; full alternating draft (table order); assert one out-of-turn pick and one taken pick each produce structured rejections; assert squads/undrafted whale in synced state; setPitcher applied (currentPitcherId + fielder at slot 0) and a batting-side attempt rejected; then play at least one full innings EACH WAY (reuse the m6 game loop) asserting `fielders` keys equal the correct drafted five after the switch and the defaults (kian then joel) hold until nominated otherwise. Exit non-zero on any failed assertion; log to `m7-acceptance.txt`.
- [ ] **Step 2: Browser acceptance** (Playwright, two pages): click through the ENTIRE draft via the real card UI (page A picks on A's turns, page B on B's), screenshot mid-draft (some cards badged) and completion; fielding page nominates a pitcher by click; screenshots `m7-01/02/03`.
- [ ] **Step 3: Docs.** CLAUDE.md: §6.1 overwrite (M7 status, module list gains DraftModule + DraftScreen, new test counts per file); §6.2 rows (2026-07-04): picksEach rule + 5/5-undrafted decision; pick-order fielding + separate pitcher nomination (setPitcher pulled forward from M8, USER-APPROVED); rematch keeps squads (no re-draft); §6.3 changelog entry (files, verification counts, deviations); §6.4: remove/supersede any auto-draft notes; add "bench is empty at 11 characters — bench/subs surface with roster growth + M8". TUNING.md only if warranted.
- [ ] **Step 4: `npm run check` green; kill dev servers; no package-lock churn. Commit: `docs: M7 acceptance evidence and project log`.** If acceptance exposes a real defect: STOP, report BLOCKED with evidence — do not fix src.

---

## Self-Review Notes (already applied)

- Spec §1 correction folded in (constants already exist under GAME).
- `rebuildFielding` no-op guard (`squad.length === 0`) keeps pre-draft syncs safe; the onCreate placeholder `createFieldingModule([], …)` keeps `fielding` non-null so no call-site guards are needed. If `createFieldingModule([])` throws on an empty setup, fix by allowing empty (a fielding module with no fielders ticks to null events) — that is an acceptable, documented FieldingModule touch.
- Type consistency: `draftPick`/`setPitcher` handler names, schema field names, and `MatchStateView` extensions match across Tasks 3–5; `DraftView.turn: TeamSide | null` maps to schema `draftTurn: ''` sentinel.
- The taken-pick test's mid-draft `draftSquads` resume is flagged in-place (generalise or draft explicitly) — implementer's choice, both correct.
- Rematch semantics (same squads, pitcher back to default) covered by Task 3 Step 4f; spec §4 "draft NOT re-run".
