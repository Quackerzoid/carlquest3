# Milestone 8 — Positioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-play repositioning (click fielder → click ground), substitution with a persistent cross-play stamina ledger, and next-batter selection — validated server-side per spec §4.

**Architecture:** New pure `PositioningModule` (one per side, persists across innings) owns positions/bench/subs; MatchRoom's existing `rebuildFielding` seam becomes layout-driven from it (pitcher pinned to `PITCHING_SPOT`); a MatchRoom stamina ledger seeds fielding rebuilds and regens the benched; RulesModule gains `setNextBatter`. Client: 3D raycast picking + the DraftScreen sheet gains positioning modes.

**Tech Stack:** TypeScript strict, Colyseus 0.15, Vitest + @colyseus/testing, Three.js raycasting, plain-DOM client.

**Design spec:** `docs/superpowers/specs/2026-07-04-m8-positioning-design.md` — read before any task. One refinement locked here: the spec's pitcher-guard "setter or parameter" is satisfied at the ROOM layer (the room rejects reposition/substitute targeting `this.pitcherId` before calling the module) so PositioningModule stays pitcher-agnostic and pure.

## Global Constraints

- TypeScript strict; no `any`/`@ts-ignore` without a justifying comment. British English.
- Server authoritative; targeted `reject(client, message, reason)`; exact reasons `'wrongRole'`/`'paused'`, prose otherwise; 'paused' checked FIRST in every handler.
- All tunables in `shared/src/constants.ts`. New FIELD values (exact): `LEGAL_ZONE: { minX: -20, maxX: 20, minZ: -6, maxZ: 32 }` (encloses every FIELDING_POSITIONS entry and post — structural test pins that), `BATTING_SQUARE_KEEPOUT: 3`, `PITCHING_SPOT` = the BOWLING_SQUARE object (alias, `FIELDING_POSITIONS[0]`). Reuse `GAME.SUBS_PER_INNINGS_CASUAL` (Infinity) and `GAME.BENCH_STAMINA_REGEN` (1).
- Verification per task: `npm run check` green. Existing-test churn expected where fielding layouts/stamina now flow through the new seams — never weaken a gate.
- Concurrent implementers do NOT commit; controller serialises. Worktree via superpowers:using-git-worktrees.
- Deterministic draft facts (test helpers already exist): A = carl,laurie,joel,jonty,joe; B = kian,josh,darcy,robbie,ricy; B's default pitcher kian; A's joel. `draftSquads(room, clientA, clientB)` + `startPlay(...)` helpers exist in MatchRoom.test.ts.

## File Structure

- Create: `server/src/modules/PositioningModule.ts`, `server/test/PositioningModule.test.ts`, `client/src/PositioningControls.ts`
- Modify: `shared/src/types.ts` (+3 message types) + `shared/test/types.test.ts`; `shared/src/constants.ts` (+FIELD values) + `shared/test/constants.test.ts`
- Modify: `server/src/modules/RulesModule.ts` (+`setNextBatter`, +`queue` in view) + test
- Modify: `server/src/modules/FieldingModule.ts` (optional per-fielder initial stamina) + test
- Modify: `server/src/rooms/MatchState.ts` (+benchA/B, subsUsedA/B, queueIds), `server/src/rooms/MatchRoom.ts`, `server/test/MatchRoom.test.ts`
- Modify: `client/src/NetModule.ts`, `client/src/DraftScreen.ts`, `client/src/RenderModule.ts` (pick/select), `client/src/main.ts`
- Create: `docs/superpowers/acceptance/m8-*` (Task 5)

**Sequencing:** Task 1 ∥ Task 2 (disjoint) → Task 3 (server, consumes both) ∥ Task 4 (client) → Task 5.

---

### Task 1: Shared contracts + pure PositioningModule

**Files:**
- Modify: `shared/src/types.ts`, `shared/test/types.test.ts`, `shared/src/constants.ts`, `shared/test/constants.test.ts`
- Create: `server/src/modules/PositioningModule.ts`
- Test: `server/test/PositioningModule.test.ts`

**Interfaces:**
- Produces (Tasks 3–4 depend on exact names): `RepositionInput { id: string; x: number; z: number }`, `SubstituteInput { outId: string; inId: string }`, `SetBatterInput { id: string }`; `FIELD.LEGAL_ZONE/BATTING_SQUARE_KEEPOUT/PITCHING_SPOT`; `createPositioningModule(squad: Character[], fieldSlots: number)` → `{ view(): PositioningView; reposition(id, x, z): boolean; substitute(outId, inId): boolean; resetSubs(): void }`; `PositioningView { positions: Record<string, { x: number; z: number }>; onField: string[]; bench: string[]; subsUsed: number }`.

- [ ] **Step 1: Shared types + constants.** Types (next to the other §7 shapes):

```typescript
/** §7 reposition message: move an on-field fielder to (x, z), server-validated. */
export interface RepositionInput {
  id: string;
  x: number;
  z: number;
}

/** §7 substitute message: swap an on-field character for a benched one. */
export interface SubstituteInput {
  outId: string;
  inId: string;
}

/** §7 setBatter message: the batting side's chosen next batter (must be in the queue). */
export interface SetBatterInput {
  id: string;
}
```

Constants — in the FIELD block:

```typescript
  /** Rectangular legal fielding area (spec §4); placeholder like the rest of the field geometry. */
  LEGAL_ZONE: { minX: -20, maxX: 20, minZ: -6, maxZ: 32 },
  /** Fielders must stay at least this far (m) from the batting square (spec §4). */
  BATTING_SQUARE_KEEPOUT: 3,
  /** The designated pitcher always stands here (spec §4); alias of the bowling square. */
  PITCHING_SPOT: BOWLING_SQUARE,
```

Structural pins in `shared/test/constants.test.ts` (match the file's style): LEGAL_ZONE contains every FIELDING_POSITIONS entry AND every POSTS entry (loop assertions), KEEPOUT = 3 and positive, PITCHING_SPOT equals FIELDING_POSITIONS[0]. Types pins for the three new inputs in `types.test.ts`.

- [ ] **Step 2: Failing PositioningModule tests** (`server/test/PositioningModule.test.ts`):

```typescript
import { describe, expect, it } from 'vitest';
import { CHARACTERS, CONST } from '@carlquest/shared';
import { createPositioningModule } from '../src/modules/PositioningModule';

const { FIELD } = CONST;
const SQUAD = CHARACTERS.slice(0, 5); // any five; ids by index below
const id = (i: number): string => SQUAD[i]?.id ?? '';

describe('PositioningModule', () => {
  it('defaults: first fieldSlots on-field at the slot layout, rest benched', () => {
    const pos = createPositioningModule([...SQUAD], 3);
    const v = pos.view();
    expect(v.onField).toEqual([id(0), id(1), id(2)]);
    expect(v.bench).toEqual([id(3), id(4)]);
    expect(v.positions[id(1)]).toEqual({ x: FIELD.FIELDING_POSITIONS[1]?.x, z: FIELD.FIELDING_POSITIONS[1]?.z });
    expect(v.subsUsed).toBe(0);
  });

  it('reposition: legal moves apply; off-field, out-of-zone and keep-out moves are refused', () => {
    const pos = createPositioningModule([...SQUAD], 3);
    expect(pos.reposition(id(1), 5, 20)).toBe(true);
    expect(pos.view().positions[id(1)]).toEqual({ x: 5, z: 20 });
    expect(pos.reposition(id(3), 5, 20)).toBe(false); // benched
    expect(pos.reposition(id(1), FIELD.LEGAL_ZONE.maxX + 1, 20)).toBe(false); // out of zone
    expect(pos.reposition(id(1), FIELD.BATTING_SQUARE.x + 1, FIELD.BATTING_SQUARE.z + 1)).toBe(false); // keep-out
    expect(pos.view().positions[id(1)]).toEqual({ x: 5, z: 20 }); // refusals do not move anyone
  });

  it('substitute: bench swap inherits the position, cap enforced, membership validated', () => {
    const pos = createPositioningModule([...SQUAD], 3);
    pos.reposition(id(2), 8, 22);
    expect(pos.substitute(id(2), id(3))).toBe(true);
    const v = pos.view();
    expect(v.onField).toEqual([id(0), id(1), id(3)]); // inId takes outId's slot in order
    expect(v.bench).toEqual([id(2), id(4)]);
    expect(v.positions[id(3)]).toEqual({ x: 8, z: 22 }); // inherited
    expect(v.positions[id(2)]).toBeUndefined();
    expect(v.subsUsed).toBe(1);
    expect(pos.substitute(id(4), id(2))).toBe(false); // id(4) is benched, not on-field
    expect(pos.substitute(id(1), id(1))).toBe(false); // not benched
  });

  it('resetSubs zeroes the counter but keeps positions and the current on-field set', () => {
    const pos = createPositioningModule([...SQUAD], 3);
    pos.substitute(id(0), id(4));
    pos.reposition(id(4), -5, 10);
    pos.resetSubs();
    const v = pos.view();
    expect(v.subsUsed).toBe(0);
    expect(v.onField).toEqual([id(4), id(1), id(2)]);
    expect(v.positions[id(4)]).toEqual({ x: -5, z: 10 });
  });

  it('a squad smaller than fieldSlots fields everyone with an empty bench', () => {
    const pos = createPositioningModule([...SQUAD], 9);
    expect(pos.view().onField).toHaveLength(5);
    expect(pos.view().bench).toEqual([]);
  });
});
```

(The subs cap itself is `Infinity` casual — cover the cap arm with a direct unit call: temporarily constructing with a finite cap is NOT possible since the module reads CONST; instead assert `subsUsed` increments and document that the cap arm is `subsUsed < GAME.SUBS_PER_INNINGS_CASUAL`, exercised structurally. Do NOT mock CONST.)

- [ ] **Step 3: RED** — `/server`: `npx vitest run test/PositioningModule.test.ts` fails (module missing).

- [ ] **Step 4: Implement** `server/src/modules/PositioningModule.ts`:

```typescript
import { CONST, type Character } from '@carlquest/shared';

const { FIELD, GAME } = CONST;

export interface PositioningView {
  /** Current (x, z) per ON-FIELD character id. */
  positions: Record<string, { x: number; z: number }>;
  /** On-field ids, pick order (substitutions replace in place). */
  onField: string[];
  bench: string[];
  subsUsed: number;
}

/**
 * Pre-play positioning state for ONE side (spec §4): custom fielder positions,
 * bench membership and the per-innings substitution counter. Pure — pitcher
 * pinning and phase/role gating live in the room. Positions and bench persist
 * for the side across the whole game; a rematch constructs fresh modules.
 */
export function createPositioningModule(
  squad: Character[],
  fieldSlots: number,
): {
  view(): PositioningView;
  reposition(id: string, x: number, z: number): boolean;
  substitute(outId: string, inId: string): boolean;
  resetSubs(): void;
} {
  const slots = Math.max(0, Math.min(fieldSlots, FIELD.FIELDING_POSITIONS.length));
  const onField = squad.slice(0, slots).map((c) => c.id);
  const bench = squad.slice(slots).map((c) => c.id);
  const positions: Record<string, { x: number; z: number }> = {};
  onField.forEach((id, i) => {
    const slot = FIELD.FIELDING_POSITIONS[i];
    if (slot === undefined) throw new RangeError(`no fielding slot ${i}`);
    positions[id] = { x: slot.x, z: slot.z };
  });
  let subsUsed = 0;

  function legal(x: number, z: number): boolean {
    const zone = FIELD.LEGAL_ZONE;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (x < zone.minX || x > zone.maxX || z < zone.minZ || z > zone.maxZ) return false;
    const dist = Math.hypot(x - FIELD.BATTING_SQUARE.x, z - FIELD.BATTING_SQUARE.z);
    return dist > FIELD.BATTING_SQUARE_KEEPOUT;
  }

  return {
    view() {
      const copy: Record<string, { x: number; z: number }> = {};
      for (const [id, p] of Object.entries(positions)) copy[id] = { ...p };
      return { positions: copy, onField: [...onField], bench: [...bench], subsUsed };
    },
    reposition(id, x, z) {
      if (!onField.includes(id) || !legal(x, z)) return false;
      positions[id] = { x, z };
      return true;
    },
    substitute(outId, inId) {
      const outIdx = onField.indexOf(outId);
      const inIdx = bench.indexOf(inId);
      if (outIdx === -1 || inIdx === -1) return false;
      if (!(subsUsed < GAME.SUBS_PER_INNINGS_CASUAL)) return false;
      onField[outIdx] = inId;
      bench[inIdx] = outId;
      const p = positions[outId];
      if (p !== undefined) positions[inId] = p;
      delete positions[outId]; // eslint-disable-line @typescript-eslint/no-dynamic-delete -- keyed by trusted roster id
      subsUsed += 1;
      return true;
    },
    resetSubs() {
      subsUsed = 0;
    },
  };
}
```

(If the eslint directive is unnecessary in this config, drop it.)

- [ ] **Step 5: GREEN** — PositioningModule tests + `/shared` tests pass; then `npm run check` (typecheck only matters here — MatchRoom untouched). Controller commits: `feat(server): pure PositioningModule + shared positioning contracts`.

---

### Task 2: RulesModule.setNextBatter + queue exposure

**Files:**
- Modify: `server/src/modules/RulesModule.ts`, `server/test/RulesModule.test.ts`

**Interfaces:**
- Produces: `setNextBatter(id: string): boolean` — valid only when a batter is up and `id` is in the remaining queue; swaps: chosen id becomes `currentBatterId`, the displaced batter returns to the FRONT of the queue. `RulesView` gains `queue: string[]` (remaining batting queue, front first, excluding the current batter). Task 3 syncs `queue` to schema; Task 4 renders it.

- [ ] **Step 1: Failing tests** (match the file's `char()`/`squad()` idiom):

```typescript
describe('setNextBatter (M8)', () => {
  it('swaps a queued id in as the current batter, displaced batter to the queue front', () => {
    const rules = createRulesModule({ squadA: squad('a', 3), squadB: squad('b', 3) });
    rules.bothConnected();
    rules.completeDraft();
    rules.confirmPositioning();
    rules.readyForPlay();
    expect(rules.view().currentBatterId).toBe('a1');
    expect(rules.view().queue).toEqual(['a2', 'a3']);
    expect(rules.setNextBatter('a3')).toBe(true);
    expect(rules.view().currentBatterId).toBe('a3');
    expect(rules.view().queue).toEqual(['a1', 'a2']);
  });

  it('rejects ids not in the queue (unknown, current batter, other side)', () => {
    const rules = createRulesModule({ squadA: squad('a', 3), squadB: squad('b', 3) });
    rules.bothConnected();
    rules.completeDraft();
    rules.confirmPositioning();
    rules.readyForPlay();
    expect(rules.setNextBatter('a1')).toBe(false); // already up
    expect(rules.setNextBatter('b1')).toBe(false); // other side
    expect(rules.setNextBatter('nobody')).toBe(false);
    expect(rules.view().currentBatterId).toBe('a1');
  });
});
```

(Adapt helper names to the file's real idiom — `squad('a', 3)` stands for its existing squad-builder producing ids a1..a3. If `queue` isn't yet in the view, the first test's queue assertion is part of the RED.)

- [ ] **Step 2: RED** — `npx vitest run test/RulesModule.test.ts -t 'setNextBatter'`.

- [ ] **Step 3: Implement.** In view(): add `queue: [...queue]`. New function next to the other transitions + wire into the return object and its type annotation:

```typescript
  /**
   * Batting side picks the next batter (spec §4, M8 — 'choose next batter only').
   * Valid whenever a batter is up and `id` waits in the queue; the displaced
   * current batter returns to the FRONT of the queue (their turn is deferred,
   * not lost). Phase/role gating is the room's job.
   */
  function setNextBatter(id: string): boolean {
    if (currentBatterId === null) return false;
    const idx = queue.indexOf(id);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    queue.unshift(currentBatterId);
    currentBatterId = id;
    return true;
  }
```

Also add `queue: string[]` to the exported `RulesView` interface.

- [ ] **Step 4: GREEN** — full RulesModule file passes; `npx tsc --noEmit -p server/tsconfig.json` clean. Controller commits: `feat(server): setNextBatter + batting queue in the rules view`.

---

### Task 3: FieldingModule stamina seed + MatchRoom wiring + ledger

**Files:**
- Modify: `server/src/modules/FieldingModule.ts` (+ `server/test/FieldingModule.test.ts`), `server/src/rooms/MatchState.ts`, `server/src/rooms/MatchRoom.ts`
- Test: `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: Task 1's PositioningModule + message types + FIELD constants; Task 2's `setNextBatter`/`queue`.
- Produces: `FielderSetup` gains optional `stamina?: number` (shared/src/types.ts — initial stamina; absent = stat stamina; `reset()` restores THIS seeded value); schema `benchA`/`benchB` (ArraySchema<string>), `subsUsedA`/`subsUsedB` (number), `queueIds` (ArraySchema<string>, the BATTING side's remaining queue); messages `reposition`/`substitute`/`setBatter` per the spec §4 matrix; `MatchRoomOptions.fieldSlotsOverride?: number` (test-only, validated: positive integer ≤ FIELDING_POSITIONS.length).

- [ ] **Step 1: FieldingModule seed (TDD).** Failing test in FieldingModule.test.ts: build a module with `[{ character, position, stamina: 2 }]`-style setup and assert `getFielders()[0].stamina === 2` initially AND after `reset()` (not the stat value). Implement: `FielderSetup` (shared types) gains `stamina?: number`; the module's internal fielder init and `reset()` use `setup.stamina ?? character.stats.stamina`. Update the shared types pin if the types test enumerates FielderSetup keys.

- [ ] **Step 2: Schema.** `MatchState` M8 section:

```typescript
  // --- M8 positioning ---------------------------------------------------------
  /** Benched ids per side (pick order). Empty until squads outgrow the field slots. */
  @type(['string']) benchA = new ArraySchema<string>();
  @type(['string']) benchB = new ArraySchema<string>();
  @type('number') subsUsedA = 0;
  @type('number') subsUsedB = 0;
  /** The BATTING side's remaining queue (front first, excludes the current batter). */
  @type(['string']) queueIds = new ArraySchema<string>();
```

- [ ] **Step 3: Failing room tests** (new `describe('M8 positioning', ...)`; all use the existing `connectPair`/`draftSquads`/`waitForPhase`/`waitForCondition` helpers; A bats first so B fields):

```typescript
describe('M8 positioning', () => {
  it('fielding side repositions a fielder; the schema fielder moves and survives into PLAY', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    clientB.send('reposition', { id: 'josh', x: 5, z: 20 });
    await waitForCondition(room, () => room.state.fielders.get('josh')?.x === 5);
    expect(room.state.fielders.get('josh')?.z).toBe(20);
    await startPlay(room, clientA, clientB);
    expect(room.state.fielders.get('josh')?.x).toBe(5); // layout survived PRE_PLAY → PLAY
    clientB.send('reposition', { id: 'josh', x: 6, z: 20 }); // locked in PLAY
    await waitForCondition(room, () => room.state.lastRejection.includes('reposition'));
    expect(room.state.fielders.get('josh')?.x).toBe(5);
  });

  it('rejects: batting side (wrongRole), the pitcher, out-of-zone and keep-out spots', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    clientA.send('reposition', { id: 'joel', x: 5, z: 20 });
    await waitForCondition(room, () => room.state.lastRejection.includes('reposition'));
    expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
    clientB.send('reposition', { id: 'kian', x: 5, z: 20 }); // the pitcher — nominate, don't drag
    await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason.includes('pitcher'));
    clientB.send('reposition', { id: 'josh', x: 999, z: 20 });
    await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason.includes('illegal'));
    clientB.send('reposition', { id: 'josh', x: 1, z: 1 }); // inside the keep-out
    await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason.includes('illegal'));
  });

  it('layout persists across an innings switch and returns intact next innings', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_CATCH });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    clientB.send('reposition', { id: 'josh', x: 5, z: 20 });
    await waitForCondition(room, () => room.state.fielders.get('josh')?.x === 5);
    // Bat out side A (5 caught batters), then side B — back to A batting, B fielding.
    while (room.state.battingSide === 'A' && room.state.phase !== 'GAME_OVER') {
      await startPlay(room, clientA, clientB);
      await pitchThenSwing(room, clientA, clientB, { x: 0.55, y: 0.47, z: 0.65 });
      await waitForCondition(room, () => room.state.phase !== 'PLAY');
    }
    expect(room.state.fielders.get('joel')).toBeDefined(); // A's five field now
    while (room.state.battingSide === 'B' && room.state.phase !== 'GAME_OVER') {
      await startPlay(room, clientA, clientB);
      await pitchThenSwing(room, clientA, clientB, { x: 0.55, y: 0.47, z: 0.65 });
      await waitForCondition(room, () => room.state.phase !== 'PLAY');
    }
    if (room.state.phase !== 'GAME_OVER') {
      expect(room.state.fielders.get('josh')?.x).toBe(5); // B's custom layout came back
    }
  });

  it('substitute works with a real bench (fieldSlotsOverride) and syncs bench/count', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS, fieldSlotsOverride: 3 });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    expect([...room.state.benchB]).toEqual(['robbie', 'ricy']); // B's picks 4-5 benched at 3 slots
    expect(room.state.fielders.size).toBe(3);
    clientB.send('substitute', { outId: 'josh', inId: 'ricy' });
    await waitForCondition(room, () => room.state.subsUsedB === 1);
    expect(room.state.fielders.get('ricy')).toBeDefined();
    expect(room.state.fielders.get('josh')).toBeUndefined();
    expect([...room.state.benchB]).toContain('josh');
    clientA.send('substitute', { outId: 'joel', inId: 'joe' }); // batting side
    await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason === 'wrongRole');
  });

  it('setBatter: batting side picks any queued batter; fielding side rejected', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    expect(room.state.currentBatterId).toBe('carl');
    expect([...room.state.queueIds]).toEqual(['laurie', 'joel', 'jonty', 'joe']);
    clientB.send('setBatter', { id: 'joe' });
    await waitForCondition(room, () => JSON.parse(room.state.lastRejection).reason === 'wrongRole');
    clientA.send('setBatter', { id: 'joe' });
    await waitForCondition(room, () => room.state.currentBatterId === 'joe');
    expect([...room.state.queueIds]).toEqual(['carl', 'laurie', 'joel', 'jonty']);
  });

  it('stamina persists across plays and the benched regain (ledger)', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS, fieldSlotsOverride: 3 });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'DRAFT');
    await draftSquads(room, clientA, clientB);
    await startPlay(room, clientA, clientB);
    await pitchThenSwing(room, clientA, clientB, { x: 0.55, y: 0.47, z: 0.65 });
    await waitForCondition(room, () => room.state.phase !== 'PLAY');
    // A chaser sprinted last play: SOME on-field fielder is below stat stamina next play.
    const drained = [...room.state.fielders.values()].some(
      (f) => f.stamina < (CHARACTERS.find((c) => c.id === f.id)?.stats.stamina ?? 0),
    );
    expect(drained).toBe(true);
  });
});
```

(The persistence test's guard-if-GAME_OVER: a 3-innings-pair game can end before B fields again depending on scoring; structure the loops exactly like the existing full-game tests in the file — reuse their idiom if tighter. The drained-stamina assertion may need the play to actually make fielders chase — the flat drive does. If no fielder sprints with ALWAYS_MISS + a a flat drive, pick the aim the existing caught/gathered tests use to force a chase and document it.)

- [ ] **Step 4: RED** — `npx vitest run test/MatchRoom.test.ts -t 'M8 positioning'`.

- [ ] **Step 5: Implement in MatchRoom.**

5a. Fields:

```typescript
  private positioning: Record<TeamSide, ReturnType<typeof createPositioningModule>> | null = null;
  /** Cross-play stamina ledger (spec §4 BENCH_STAMINA_REGEN; M8 closes the static-stamina gap). */
  private staminaById = new Map<string, number>();
  private fieldSlots = FIELD.FIELDING_POSITIONS.length;
```

In `onCreate`: validate `options.fieldSlotsOverride` (integer, `> 0`, `<= FIELD.FIELDING_POSITIONS.length`) into `this.fieldSlots` (document as test-only like `seed`). On draft completion (in `handleDraftPick`) after `this.squads = ...`: create both positioning modules (`fieldSlots = Math.min(this.fieldSlots, squad.length)` per side handled inside the module) and seed the ledger:

```typescript
      this.positioning = {
        A: createPositioningModule(squads.squadA, this.fieldSlots),
        B: createPositioningModule(squads.squadB, this.fieldSlots),
      };
      this.staminaById.clear();
      for (const c of [...squads.squadA, ...squads.squadB]) this.staminaById.set(c.id, c.stats.stamina);
```

5b. `rebuildFielding` becomes layout-driven — replace its ordered/setup derivation:

```typescript
    const layout = this.positioning?.[side].view();
    if (layout === undefined || squad.length === 0) return;
    const byId = new Map(squad.map((c) => [c.id, c]));
    const setup: FielderSetup[] = layout.onField.map((id) => {
      const character = byId.get(id);
      const custom = layout.positions[id];
      if (character === undefined || custom === undefined) throw new Error(`positioning out of sync for ${id}`);
      const position = id === this.pitcherId ? FIELD.PITCHING_SPOT : custom;
      return { character, position, stamina: this.staminaById.get(id) ?? character.stats.stamina };
    });
    // Pitcher first (setup order = catch tie-break order, M7 convention).
    setup.sort((a, b) => (a.character.id === this.pitcherId ? -1 : b.character.id === this.pitcherId ? 1 : 0));
```

CAREFUL: `defaultPitcherId`/`pitcherId` must be chosen from the ON-FIELD set (`layout.onField`), not the whole squad — a benched best-arm cannot bowl; if the current pitcher gets substituted OUT, re-derive the default from the new on-field set (see 5d). (`Array.prototype.sort` stability is guaranteed — the non-pitcher order is preserved.)

5c. Ledger flow in `endPlay` (before the fielding module is replaced): absorb + regen:

```typescript
    for (const f of this.fielding.getFielders()) this.staminaById.set(f.id, f.stamina);
    // Everyone NOT on the fielding field regains bench stamina, capped at stat (spec §4).
    const onField = new Set(this.fielding.getFielders().map((f) => f.id));
    for (const [id, s] of this.staminaById) {
      if (onField.has(id)) continue;
      const stat = getCharacter(id).stats.stamina;
      this.staminaById.set(id, Math.min(stat, s + GAME.BENCH_STAMINA_REGEN));
    }
```

Place this at the TOP of `endPlay` (fielding state is still the played module). Rematch: re-seed the ledger and recreate both positioning modules (fresh defaults per spec). Innings change (where `running.reset()` already triggers): `this.positioning?.A.resetSubs(); this.positioning?.B.resetSubs();`.

5d. Handlers (register in onCreate like the others):

```typescript
  private handleReposition(client: Client, message: unknown): void {
    if (this.state.paused) { this.reject(client, 'reposition', 'paused'); return; }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'reposition', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) { this.reject(client, 'reposition', 'wrongRole'); return; }
    const m = asRecord(message) as Partial<RepositionInput>;
    if (typeof m.id !== 'string' || !isFiniteNumber(m.x) || !isFiniteNumber(m.z)) {
      this.reject(client, 'reposition', 'malformed input');
      return;
    }
    if (m.id === this.pitcherId) { this.reject(client, 'reposition', 'the pitcher moves via setPitcher'); return; }
    const pos = this.positioning?.[this.fieldingSide()];
    if (pos === undefined || !pos.reposition(m.id, m.x, m.z)) {
      this.reject(client, 'reposition', 'illegal spot or not an on-field fielder');
      return;
    }
    this.rebuildFielding();
    this.syncPositioning();
  }

  private handleSubstitute(client: Client, message: unknown): void {
    if (this.state.paused) { this.reject(client, 'substitute', 'paused'); return; }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'substitute', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.fieldingSide()) { this.reject(client, 'substitute', 'wrongRole'); return; }
    const m = asRecord(message) as Partial<SubstituteInput>;
    if (typeof m.outId !== 'string' || typeof m.inId !== 'string') {
      this.reject(client, 'substitute', 'malformed input');
      return;
    }
    const side = this.fieldingSide();
    const pos = this.positioning?.[side];
    if (pos === undefined || !pos.substitute(m.outId, m.inId)) {
      this.reject(client, 'substitute', 'not a legal substitution (bench membership or cap)');
      return;
    }
    if (m.outId === this.pitcherId) {
      // The bowler left the field: the new on-field set's best arm takes over.
      this.pitcherId = this.defaultPitcherFromIds(pos.view().onField, side);
    }
    this.rebuildFielding();
    this.syncPositioning();
  }

  private handleSetBatter(client: Client, message: unknown): void {
    if (this.state.paused) { this.reject(client, 'setBatter', 'paused'); return; }
    const phase = this.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') {
      this.reject(client, 'setBatter', `only allowed in INITIAL_POSITIONING or PRE_PLAY (phase ${phase})`);
      return;
    }
    if (this.sideOf(client) !== this.rules.view().battingSide) { this.reject(client, 'setBatter', 'wrongRole'); return; }
    const m = asRecord(message) as Partial<SetBatterInput>;
    if (typeof m.id !== 'string' || !this.rules.setNextBatter(m.id)) {
      this.reject(client, 'setBatter', 'not in the batting queue');
      return;
    }
    this.syncRulesView();
  }
```

`defaultPitcherId(squad)` is refactored to `defaultPitcherFromIds(ids: string[], side: TeamSide)` reading characters via the squad map (or keep both — implementer's judgement, no behaviour change for the M7 path but the default MUST now derive from the ON-FIELD set). `syncPositioning()` splices benchA/B + subsUsedA/B from both modules' views; `syncRulesView` additionally splices `queueIds` from `v.queue`. Wire `queueIds` into `syncRulesView` (the queue changes at every play resolution too).

- [ ] **Step 6: GREEN + migration.** Full MatchRoom file green; existing tests should be largely untouched (default layouts equal the old slot map; pitcher pinning preserves kian at the bowling square). Any fielder-position expectation that breaks: check the default layout equivalence first — a genuine mismatch means a bug in 5b, not a test to re-derive. `npm run check` green (shared + server + client typecheck — client untouched but recompiles). Controller commits: `feat(server): positioning module wiring, stamina ledger, setBatter`.

---

### Task 4: Client — raycast reposition, panel modes, senders (parallel with Task 3)

**Files:**
- Create: `client/src/PositioningControls.ts`
- Modify: `client/src/NetModule.ts`, `client/src/RenderModule.ts`, `client/src/DraftScreen.ts`, `client/src/main.ts`

**Interfaces:**
- Consumes: Task 1's input types; Task 3's schema names (`benchA/benchB: readonly string[]`, `subsUsedA/subsUsedB: number`, `queueIds: readonly string[]` — defensive reads while Task 3 is in flight); existing `createScene` return `{ scene, camera, renderer, start }`.
- Produces: `Net.sendReposition/sendSubstitute/sendSetBatter`; `FieldersView` gains `pickId(raycaster: THREE.Raycaster): string | null` and `setSelected(id: string | null)`; `createPositioningControls(canvas, camera, fielders, net, selection, onLocalAction)` → `{ detach(): void }`; a tiny shared selection store in main.ts: `{ get(): string | null; set(id: string | null): void }` passed to both the controls and the DraftScreen.

**UI note:** MANDATORY unslop-ui invocation before styling the new panel modes; same scorer's-sheet language (monospace, parchment, hairline, bracketed badges).

- [ ] **Step 1: NetModule.** Add the three senders + `MatchStateView` fields (`benchA: readonly string[]; benchB: readonly string[]; subsUsedA: number; subsUsedB: number; queueIds: readonly string[];`).

- [ ] **Step 2: RenderModule picking.** Extend `createFieldersView`: keep a `selected: string | null`; in `update`, apply the selection tint (`emissive` highlight via a third material or `mesh.scale.setScalar(1.15)` — pick ONE mechanism consistent with the existing holder-tint approach); add:

```typescript
    pickId(raycaster: THREE.Raycaster): string | null {
      const hits = raycaster.intersectObjects([...meshes.values()]);
      const first = hits[0]?.object;
      if (first === undefined) return null;
      for (const [id, mesh] of meshes) if (mesh === first) return id;
      return null;
    },
    setSelected(id: string | null): void { ... }
```

- [ ] **Step 3: PositioningControls** (`client/src/PositioningControls.ts`): canvas click listener (named handler + `detach()`, the attachInput pattern):
  - Active only when `net.phase()` is INITIAL_POSITIONING/PRE_PLAY AND `net.mySide()` is the fielding side (derive: `mySide !== state.battingSide`).
  - On click: NDC from the event, `raycaster.setFromCamera(ndc, camera)`; `fielders.pickId(...)` — own on-field fielder (not the current pitcher): `selection.set(id)`; else if `selection.get() !== null`: intersect the maths plane `y = 0` (`new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)`, `raycaster.ray.intersectPlane`) → `net.sendReposition({ id, x: point.x, z: point.z })` and keep the selection (server patch moves the capsule; a rejection surfaces on the status line).
  - Escape key clears the selection (piggyback on the same handler or a tiny keydown with detach).
  - `fielders.setSelected` mirrors every selection change.

- [ ] **Step 4: DraftScreen panel modes.** Extend `resolveMode`/update: during INITIAL_POSITIONING/PRE_PLAY the sheet shows for BOTH sides now — fielding side: on-field rows (click = `selection.set(id)`, selected row marked; pitcher row still nominates via the existing pitcher mode — merge: the strip's rows are the on-field set; a `[bowling]` row click still sends setPitcher; a non-pitcher row click selects for reposition), bench rows under a `bench` rule (click with a selection = `sendSubstitute({ outId: selection.get(), inId })`; empty bench renders one disabled row `bench — awaiting roster growth`), plus `subs used: N`. Batting side: queue rows (click = `sendSetBatter({id})`, current batter marked `[batting]`). Keep DRAFT mode unchanged. This grows DraftScreen — if it passes ~300 lines, split the row-building helper into the module top rather than a new file (same responsibility).

- [ ] **Step 5: main.ts.** Pass `camera` from `createScene` destructure; create the selection store; instantiate `createPositioningControls` inside `runMatch` and `detach()` it in `onOpponentLeft` alongside the input detach; pass selection into `createDraftScreen`. Status line: when a fielder is selected, `moving <name> — click the field`; show `subs used` for the fielding side.

- [ ] **Step 6: Verify.** `/client` `npx tsc --noEmit -p tsconfig.json`; root `npx eslint client/src`. Both clean; live proof is Task 5. Controller commits: `feat(client): raycast repositioning, subs/next-batter panel modes`.

---

### Task 5: §9.8 acceptance + docs

**Files:**
- Create: `docs/superpowers/acceptance/m8-acceptance.mjs`, `m8-acceptance.txt`, `m8-browser-acceptance.mjs`, `m8-0*.png`
- Modify: `CLAUDE.md` §6, `TUNING.md` (LEGAL_ZONE/KEEPOUT as playtest candidates)

**Interfaces:** consumes everything; produces committed evidence. Patterns: the m7 acceptance pair.

- [ ] **Step 1: Scripted WS** (real `npm run dev`; assertion-accumulating, exit non-zero on failure): draft; reposition a fielder (schema moves), illegal spot + pitcher + wrong-role + PLAY-locked all rejected with their exact/prose reasons; play an innings to the switch and assert the layout returns when the side fields again; SECOND room with `fieldSlotsOverride: 3`: substitute (bench/count sync), sub cap NOT hit (casual Infinity — assert subsUsed increments instead), pitcher-subbed-out re-derivation, drained stamina visible next play + benched regen (compare a benched id's ledger effect after the sub); setBatter swaps the announced batter. Log → `m8-acceptance.txt`.
- [ ] **Step 2: Browser** (Playwright, two pages): fielding page clicks its own capsule (canvas coordinates from the fielder's known projected position — compute via page.evaluate with the camera, or click via the PANEL row which shares the selection, then click a ground pixel), sends a reposition, asserts the capsule moved; panel shows the empty-bench note; batting page clicks a queue row and the status line announces the new batter. Screenshots m8-01/02/03.
- [ ] **Step 3: Docs.** CLAUDE.md §6.1 overwrite (M8 status/tests/evidence); §6.2 rows: room-layer pitcher guard; ledger semantics (absorb → regen benched-of-both-sides → reseed rebuilds); fieldSlotsOverride test option; batting-side substitution deferred (USER-APPROVED scope). §6.3 entry; §6.4: REMOVE the "runner stamina is static within a play / fielder stamina doesn't feed back" item's fielder half (ledger fixes cross-play; note what remains: within-play runner speed still fixed at startRun). TUNING.md: LEGAL_ZONE, BATTING_SQUARE_KEEPOUT.
- [ ] **Step 4:** `npm run check` green; kill servers; no lock churn; commit `docs: M8 acceptance evidence and project log`. Defect → BLOCKED, don't fix src.

---

## Self-Review Notes (already applied)

- Spec §1→T1, §2→T1, §3→T3 (ledger), §4→T3 (matrix incl. room-layer pitcher guard — deviation from the spec's "setter or parameter" wording, locked in the header), §5→T4, §6→T3/T5, §7 out-of-scope respected.
- Pitcher-substituted-out re-derivation (T3 5d) is NEW versus the spec (which is silent); it follows from "exactly one designated pitcher on the field" — log as a §6.2 decision in T5.
- Type consistency: `PositioningView`/`FielderSetup.stamina`/schema names/`queue` in RulesView cross-checked across tasks; `selection` store shape shared T4-internal only.
- The keep-out test point (1,1) is √2 ≈ 1.41 m from the batting square < 3 ✓; (5,20) and (8,22) inside LEGAL_ZONE ✓; (999,20) outside ✓.
