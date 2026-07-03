# Milestone 3 — Pitch/Hit Single-Player Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single-player pitch → timed swing → rendered ball flight, with the §5 formulas landed as exhaustively-tested pure functions and the §3 roster as the sole character data source (spec §9.3 acceptance).

**Architecture:** `/shared` gains `formulas.ts` (ALL §5 formulas) and `characters.ts` (§3 roster) plus input types and seven tunables. Two pure server modules (`PitchModule.resolvePitch`, `HitModule.resolveSwing`) map stats+input → `PitchParams`/`HitParams` and feed the existing PhysicsModule. `MatchRoom` gains a 60 Hz sim tick (dt clamped to `SIM_MAX_CATCHUP`), a synced `BallSchema`, and `pitch`/`swing` handlers with idle/live validation. The client joins the room, renders the ball from schema patches, and sends inputs on keypresses. Design: `docs/superpowers/specs/2026-07-03-pitch-hit-loop-design.md`.

**Tech Stack:** existing stack + `colyseus.js` ^0.15 (client dependency, first client networking).

## Global Constraints

- TypeScript `strict: true`; no `any`, no `@ts-ignore` without a justifying comment.
- §5 formulas implemented EXACTLY (shapes below); every constant from `CONST.GAME`/`CONST.PHYSICS` — no magic numbers. §3 roster values EXACT — a silently altered stat is Critical.
- Server-authoritative: client sends inputs and renders; NO physics or game decisions client-side.
- Abilities are M9: `curveMult`/`hitCurveMult`/`windowMult` parameters exist but default to 1 — do NOT implement ability conditions.
- Determinism: no wall-clock in modules; MatchRoom's tick may use the interval's dt but clamps it.
- British English; conventional commits; TDD for every task; Node not on default PATH — prefix PowerShell npm/npx commands with `$env:Path = 'C:\Program Files\nodejs;' + $env:Path; `.

## File Structure

```
shared/src/formulas.ts           CREATE  all §5 pure functions
shared/src/characters.ts         CREATE  §3 roster (only data source)
shared/src/types.ts              MODIFY  +StatBlock, AbilityId, Character, PitchInput, SwingInput
shared/src/constants.ts          MODIFY  +7 tunables
shared/src/index.ts              MODIFY  re-export formulas + characters
shared/test/formulas.test.ts     CREATE
shared/test/characters.test.ts   CREATE
shared/test/constants.test.ts    MODIFY  pin new tunables
server/src/modules/PitchModule.ts CREATE pure resolvePitch
server/src/modules/HitModule.ts   CREATE pure resolveSwing
server/test/PitchModule.test.ts   CREATE
server/test/HitModule.test.ts     CREATE
server/src/rooms/MatchState.ts    MODIFY +BallSchema, ballLive, demoLog
server/src/rooms/MatchRoom.ts     MODIFY sim tick + handlers + timing tracker
server/test/MatchRoom.test.ts     MODIFY +integration tests
client/package.json               MODIFY +colyseus.js
client/src/NetModule.ts           CREATE  room join + state access
client/src/RenderModule.ts        CREATE  ball mesh sync
client/src/InputModule.ts         CREATE  key → message
client/src/main.ts                MODIFY  wire modules + status line
client/index.html                 MODIFY  +status <pre>
```

Task order: Task 1 first (contracts). Tasks 2 and 3 are independent of each other (different files) and MAY be dispatched in parallel. Task 4 needs 1–3; Task 5 needs 4; Task 6 last.

---

### Task 1: Shared contracts — formulas, roster, input types, tunables

**Files:**
- Create: `shared/src/formulas.ts`, `shared/src/characters.ts`, `shared/test/formulas.test.ts`, `shared/test/characters.test.ts`
- Modify: `shared/src/types.ts`, `shared/src/constants.ts`, `shared/src/index.ts`, `shared/test/constants.test.ts`

**Interfaces:**
- Consumes: `CONST` from constants.
- Produces (later tasks import all of this from `@carlquest/shared`):
  - `StatBlock { speed; reach; power; pitch; spin; stamina; reflex; instinct; nerve }` (all `number`)
  - `AbilityId` union of: `'CLUTCH_SWING' | 'CURVEBALL_MASTER' | 'LONG_REACH' | 'QUICK_DRAW' | 'CANNON_ARM' | 'SWITCH' | 'IMMOVABLE' | 'POWER_BASE' | 'BUTTERFINGERS' | 'POWERHOUSE' | 'WALL'`
  - `Character { id: string; name: string; stats: StatBlock; ability: AbilityId }`
  - `CHARACTERS: readonly Character[]` (11 entries) and `getCharacter(id: string): Character` (throws `RangeError` on unknown id)
  - `PitchInput { aim: Vec3; spinInput: number }`, `SwingInput { aim: Vec3; spinInput: number }`
  - formulas: `s01(stat: number): number`, `moveSpeed(speed: number, fatigue: number): number`, `catchRadius(reach: number): number`, `pitchSpeed(pitch: number): number`, `pitchSpin(spin: number, curveMult: number): number`, `timingWindow(reflex: number, windowMult?: number): number`, `timingFactor(timingError: number, window: number): number`, `exitVelocity(power: number, timing: number): number`, `hitSpin(spin: number, hitCurveMult: number): number`, `pCatch(instinct: number, reflex: number, approachPenalty: number): number`, `fatigueMult(stamina: number): number`, `pressureMult(nerve: number): number`, `clamp01(x: number): number`
  - constants: `GAME.HIT_ELEVATION_MIN_DEG = -10`, `GAME.HIT_ELEVATION_MAX_DEG = 60`, `GAME.PITCH_ELEVATION_MAX_DEG = 20`, `GAME.PLAY_TIMEOUT_S = 6`, `GAME.BALL_REST_SPEED = 0.1`, `GAME.BALL_REST_TIME_S = 1`, `PHYSICS.SIM_MAX_CATCHUP = 0.25`

- [ ] **Step 1: Write failing constants tests** — append to the GAME describe in `shared/test/constants.test.ts`:

```ts
    it('pins hit elevation clamp to -10..60 degrees', () => {
      expect(CONST.GAME.HIT_ELEVATION_MIN_DEG).toBe(-10);
      expect(CONST.GAME.HIT_ELEVATION_MAX_DEG).toBe(60);
    });

    it('pins pitch elevation cap to 20 degrees', () => {
      expect(CONST.GAME.PITCH_ELEVATION_MAX_DEG).toBe(20);
    });

    it('pins demo play-end tunables', () => {
      expect(CONST.GAME.PLAY_TIMEOUT_S).toBe(6);
      expect(CONST.GAME.BALL_REST_SPEED).toBe(0.1);
      expect(CONST.GAME.BALL_REST_TIME_S).toBe(1);
    });
```

and to the PHYSICS describe:

```ts
    it('pins the sim catch-up clamp to 0.25 s', () => {
      expect(CONST.PHYSICS.SIM_MAX_CATCHUP).toBe(0.25);
    });
```

- [ ] **Step 2: Write failing formulas tests** — create `shared/test/formulas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CONST,
  catchRadius,
  clamp01,
  exitVelocity,
  fatigueMult,
  hitSpin,
  moveSpeed,
  pCatch,
  pitchSpeed,
  pitchSpin,
  pressureMult,
  s01,
  timingFactor,
  timingWindow,
} from '../src/index';

const G = CONST.GAME;

describe('formulas (spec §5, exact shapes)', () => {
  it('s01 normalises stats to 0..1', () => {
    expect(s01(1)).toBe(0.1);
    expect(s01(5)).toBe(0.5);
    expect(s01(10)).toBe(1);
  });

  it('clamp01 clamps', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });

  it('moveSpeed spans MOVE_MIN..MOVE_MAX and scales by fatigue', () => {
    expect(moveSpeed(10, 1)).toBeCloseTo(G.MOVE_MAX, 10);
    expect(moveSpeed(5, 1)).toBeCloseTo(G.MOVE_MIN + (G.MOVE_MAX - G.MOVE_MIN) * 0.5, 10);
    expect(moveSpeed(10, 0.5)).toBeCloseTo(G.MOVE_MIN + (G.MOVE_MAX - G.MOVE_MIN) * 1 * 0.5, 10);
  });

  it('catchRadius spans REACH_MIN..REACH_MAX', () => {
    expect(catchRadius(1)).toBeCloseTo(G.REACH_MIN + (G.REACH_MAX - G.REACH_MIN) * 0.1, 10);
    expect(catchRadius(10)).toBeCloseTo(G.REACH_MAX, 10);
  });

  it('pitchSpeed spans PITCH_MIN..PITCH_MAX (Kian pitch 8 = 26.4 m/s)', () => {
    expect(pitchSpeed(8)).toBeCloseTo(26.4, 10);
    expect(pitchSpeed(1)).toBeCloseTo(G.PITCH_MIN + (G.PITCH_MAX - G.PITCH_MIN) * 0.1, 10);
  });

  it('pitchSpin scales SPIN_MAX_RADS by s01 and curveMult', () => {
    expect(pitchSpin(9, 1)).toBeCloseTo(G.SPIN_MAX_RADS * 0.9, 10);
    expect(pitchSpin(9, 1.6)).toBeCloseTo(G.SPIN_MAX_RADS * 0.9 * 1.6, 10);
    expect(pitchSpin(0, 1)).toBe(0);
  });

  it('timingWindow = BASE * (0.6 + 0.4·s01(reflex)), optional windowMult', () => {
    expect(timingWindow(10)).toBeCloseTo(G.BASE_TIMING_WINDOW * 1.0, 10);
    expect(timingWindow(5)).toBeCloseTo(G.BASE_TIMING_WINDOW * 0.8, 10);
    expect(timingWindow(10, 0.85)).toBeCloseTo(G.BASE_TIMING_WINDOW * 0.85, 10);
  });

  it('timingFactor = clamp(1 - |err|/window, 0, 1)', () => {
    const w = 0.2;
    expect(timingFactor(0, w)).toBe(1);
    expect(timingFactor(0.1, w)).toBeCloseTo(0.5, 10);
    expect(timingFactor(-0.1, w)).toBeCloseTo(0.5, 10);
    expect(timingFactor(0.2, w)).toBe(0);
    expect(timingFactor(0.5, w)).toBe(0);
  });

  it('exitVelocity spans HIT_MIN..HIT_MAX scaled by timing (Carl power 8, perfect = 34 m/s)', () => {
    expect(exitVelocity(8, 1)).toBeCloseTo(34, 10);
    expect(exitVelocity(8, 0.5)).toBeCloseTo(17, 10);
    expect(exitVelocity(8, 0)).toBe(0);
  });

  it('hitSpin mirrors pitchSpin with hitCurveMult', () => {
    expect(hitSpin(5, 1)).toBeCloseTo(G.SPIN_MAX_RADS * 0.5, 10);
    expect(hitSpin(5, 2)).toBeCloseTo(G.SPIN_MAX_RADS, 10);
  });

  it('pCatch = clamp(BASE + Iw·s01(ins) + Rw·s01(rfx) - penalty, 0, 1)', () => {
    expect(pCatch(10, 10, 0)).toBeCloseTo(G.BASE_CATCH + G.INSTINCT_W + G.REFLEX_W, 10);
    expect(pCatch(5, 5, 0)).toBeCloseTo(G.BASE_CATCH + G.INSTINCT_W * 0.5 + G.REFLEX_W * 0.5, 10);
    expect(pCatch(1, 1, 1)).toBe(0); // clamped at 0
    expect(pCatch(10, 10, -1)).toBe(1); // clamped at 1
  });

  it('fatigueMult is 1 at stamina >= 3, else 0.6 + 0.4·(stamina/3)', () => {
    expect(fatigueMult(10)).toBe(1);
    expect(fatigueMult(3)).toBe(1);
    expect(fatigueMult(2.999)).toBeCloseTo(0.6 + 0.4 * (2.999 / 3), 10);
    expect(fatigueMult(0)).toBeCloseTo(0.6, 10);
  });

  it('pressureMult = 0.85 + 0.15·s01(nerve)', () => {
    expect(pressureMult(10)).toBeCloseTo(1, 10);
    expect(pressureMult(0)).toBeCloseTo(0.85, 10);
    expect(pressureMult(8)).toBeCloseTo(0.97, 10);
  });

  it('formulas are pure (repeat calls identical)', () => {
    expect(pitchSpeed(7)).toBe(pitchSpeed(7));
    expect(pCatch(6, 7, 0.2)).toBe(pCatch(6, 7, 0.2));
  });
});
```

- [ ] **Step 3: Write failing roster tests** — create `shared/test/characters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHARACTERS, getCharacter } from '../src/index';

// Spec §3 table, transcribed exactly: [id, name, spd, rch, pow, pit, spn, sta, rfx, ins, nrv, ability]
const SPEC_ROWS = [
  ['carl', 'Carl', 7, 6, 8, 5, 5, 7, 6, 6, 8, 'CLUTCH_SWING'],
  ['kian', 'Kian', 5, 6, 5, 8, 9, 6, 7, 6, 6, 'CURVEBALL_MASTER'],
  ['laurie', 'Laurie', 6, 9, 6, 5, 5, 7, 7, 8, 6, 'LONG_REACH'],
  ['josh', 'Josh', 8, 7, 6, 6, 5, 7, 9, 6, 5, 'QUICK_DRAW'],
  ['joel', 'Joel', 6, 6, 7, 9, 6, 6, 6, 5, 6, 'CANNON_ARM'],
  ['darcy', 'Darcy', 7, 7, 7, 6, 7, 7, 7, 7, 7, 'SWITCH'],
  ['jonty', 'Jonty', 3, 8, 9, 6, 4, 5, 5, 7, 8, 'IMMOVABLE'],
  ['robbie', 'Robbie', 5, 6, 8, 5, 5, 6, 6, 6, 7, 'POWER_BASE'],
  ['joe', 'Joe', 2, 2, 2, 3, 2, 3, 2, 2, 2, 'BUTTERFINGERS'],
  ['ricy', 'Ricy', 7, 8, 8, 8, 6, 8, 7, 7, 7, 'POWERHOUSE'],
  ['whale', 'The Whale', 1, 10, 10, 4, 2, 5, 3, 6, 7, 'WALL'],
] as const;

describe('characters (spec §3, exact)', () => {
  it('contains exactly the 11 spec characters in spec order', () => {
    expect(CHARACTERS).toHaveLength(11);
    expect(CHARACTERS.map((c) => c.id)).toEqual(SPEC_ROWS.map((r) => r[0]));
  });

  it.each(SPEC_ROWS)('pins %s exactly', (id, name, spd, rch, pow, pit, spn, sta, rfx, ins, nrv, ability) => {
    const c = getCharacter(id);
    expect(c.name).toBe(name);
    expect(c.stats).toEqual({
      speed: spd, reach: rch, power: pow, pitch: pit, spin: spn,
      stamina: sta, reflex: rfx, instinct: ins, nerve: nrv,
    });
    expect(c.ability).toBe(ability);
  });

  it('all stats are integers within 1-10', () => {
    for (const c of CHARACTERS) {
      for (const v of Object.values(c.stats)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(10);
      }
    }
  });

  it('ids are unique and getCharacter throws on unknown id', () => {
    expect(new Set(CHARACTERS.map((c) => c.id)).size).toBe(11);
    expect(() => getCharacter('nobody')).toThrow(RangeError);
  });

  it('roster is frozen', () => {
    expect(Object.isFrozen(CHARACTERS)).toBe(true);
    expect(Object.isFrozen(CHARACTERS[0])).toBe(true);
  });
});
```

- [ ] **Step 4: Run to verify failure** — `npx vitest run shared` — new suites FAIL (modules missing).

- [ ] **Step 5: Implement.** `shared/src/constants.ts` — add to GAME (after `BENCH_STAMINA_REGEN`):

```ts
  /** Hit launch elevation clamp, degrees (M3 design decision, user-approved aim-based launch). */
  HIT_ELEVATION_MIN_DEG: -10,
  HIT_ELEVATION_MAX_DEG: 60,
  /** Pitch aim elevation cap, degrees (M3 design decision). */
  PITCH_ELEVATION_MAX_DEG: 20,
  /** Demo play ends after this long live, or when at rest (M3 design decisions). */
  PLAY_TIMEOUT_S: 6,
  BALL_REST_SPEED: 0.1,
  BALL_REST_TIME_S: 1,
```

and to PHYSICS (after `BALL_RELEASE_HEIGHT`):

```ts
  /** Max seconds of unsimulated time a single tick may consume (spiral-of-death clamp). */
  SIM_MAX_CATCHUP: 0.25,
```

`shared/src/types.ts` — append:

```ts
/** The nine 1-10 stats every character carries (spec §3). */
export interface StatBlock {
  speed: number;
  reach: number;
  power: number;
  pitch: number;
  spin: number;
  stamina: number;
  reflex: number;
  instinct: number;
  nerve: number;
}

/** The eleven ability identifiers (spec §3); behaviour lands in Milestone 9. */
export type AbilityId =
  | 'CLUTCH_SWING'
  | 'CURVEBALL_MASTER'
  | 'LONG_REACH'
  | 'QUICK_DRAW'
  | 'CANNON_ARM'
  | 'SWITCH'
  | 'IMMOVABLE'
  | 'POWER_BASE'
  | 'BUTTERFINGERS'
  | 'POWERHOUSE'
  | 'WALL';

export interface Character {
  id: string;
  name: string;
  stats: StatBlock;
  ability: AbilityId;
}

/** Payload of the pitch message (spec §7): aim direction + sidespin scalar in [-1, 1]. */
export interface PitchInput {
  aim: Vec3;
  spinInput: number;
}

/** Payload of the swing message (spec §7): aim direction + sidespin scalar in [-1, 1]. */
export interface SwingInput {
  aim: Vec3;
  spinInput: number;
}
```

Create `shared/src/formulas.ts`:

```ts
/**
 * Stat → gameplay formulas (spec §5). Pure functions only — no state, no I/O.
 * Every tunable comes from CONST.GAME. Stats are 1-10 integers from the roster;
 * these functions are total for any finite input and do not validate range.
 */
import { CONST } from './constants';

const G = CONST.GAME;

/** Normalise a 1-10 stat to 0..1 (spec §5: s01 = stat / 10). */
export function s01(stat: number): number {
  return stat / 10;
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Movement speed in m/s; fatigue comes from fatigueMult(stamina). */
export function moveSpeed(speed: number, fatigue: number): number {
  return G.MOVE_MIN + (G.MOVE_MAX - G.MOVE_MIN) * s01(speed) * fatigue;
}

/** Catch radius in metres (ability multipliers applied by FieldingModule, M4+). */
export function catchRadius(reach: number): number {
  return G.REACH_MIN + (G.REACH_MAX - G.REACH_MIN) * s01(reach);
}

/** Pitch initial speed in m/s. */
export function pitchSpeed(pitch: number): number {
  return G.PITCH_MIN + (G.PITCH_MAX - G.PITCH_MIN) * s01(pitch);
}

/** Pitch spin in rad/s; curveMult is 1 until CURVEBALL_MASTER (M9). */
export function pitchSpin(spin: number, curveMult: number): number {
  return G.SPIN_MAX_RADS * s01(spin) * curveMult;
}

/** Batter timing window in seconds; windowMult is 1 until CANNON_ARM (M9). */
export function timingWindow(reflex: number, windowMult = 1): number {
  return G.BASE_TIMING_WINDOW * (0.6 + 0.4 * s01(reflex)) * windowMult;
}

/** 1 at perfect timing, linearly down to 0 at the window edge. */
export function timingFactor(timingError: number, window: number): number {
  return clamp01(1 - Math.abs(timingError) / window);
}

/** Hit exit velocity in m/s. */
export function exitVelocity(power: number, timing: number): number {
  return (G.HIT_MIN + (G.HIT_MAX - G.HIT_MIN) * s01(power)) * timing;
}

/** Hit launch spin in rad/s; hitCurveMult is 1 until abilities (M9). */
export function hitSpin(spin: number, hitCurveMult: number): number {
  return G.SPIN_MAX_RADS * s01(spin) * hitCurveMult;
}

/** Catch success probability before ability overrides (spec §5). */
export function pCatch(instinct: number, reflex: number, approachPenalty: number): number {
  return clamp01(G.BASE_CATCH + G.INSTINCT_W * s01(instinct) + G.REFLEX_W * s01(reflex) - approachPenalty);
}

/** Full effectiveness at stamina >= 3, degrading to 0.6 at zero stamina. */
export function fatigueMult(stamina: number): number {
  return stamina >= 3 ? 1 : 0.6 + 0.4 * (stamina / 3);
}

/** Applied to timingFactor and pCatch in high-pressure states (spec §5). */
export function pressureMult(nerve: number): number {
  return 0.85 + 0.15 * s01(nerve);
}
```

Create `shared/src/characters.ts`:

```ts
/**
 * The character roster (spec §3) — the ONLY source of character data in the game.
 * Ability behaviour lands in Milestone 9; ids are stored from day one.
 */
import type { Character } from './types';

function deepFreeze<T extends object>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CHARACTERS: readonly Character[] = deepFreeze([
  { id: 'carl', name: 'Carl', stats: { speed: 7, reach: 6, power: 8, pitch: 5, spin: 5, stamina: 7, reflex: 6, instinct: 6, nerve: 8 }, ability: 'CLUTCH_SWING' },
  { id: 'kian', name: 'Kian', stats: { speed: 5, reach: 6, power: 5, pitch: 8, spin: 9, stamina: 6, reflex: 7, instinct: 6, nerve: 6 }, ability: 'CURVEBALL_MASTER' },
  { id: 'laurie', name: 'Laurie', stats: { speed: 6, reach: 9, power: 6, pitch: 5, spin: 5, stamina: 7, reflex: 7, instinct: 8, nerve: 6 }, ability: 'LONG_REACH' },
  { id: 'josh', name: 'Josh', stats: { speed: 8, reach: 7, power: 6, pitch: 6, spin: 5, stamina: 7, reflex: 9, instinct: 6, nerve: 5 }, ability: 'QUICK_DRAW' },
  { id: 'joel', name: 'Joel', stats: { speed: 6, reach: 6, power: 7, pitch: 9, spin: 6, stamina: 6, reflex: 6, instinct: 5, nerve: 6 }, ability: 'CANNON_ARM' },
  { id: 'darcy', name: 'Darcy', stats: { speed: 7, reach: 7, power: 7, pitch: 6, spin: 7, stamina: 7, reflex: 7, instinct: 7, nerve: 7 }, ability: 'SWITCH' },
  { id: 'jonty', name: 'Jonty', stats: { speed: 3, reach: 8, power: 9, pitch: 6, spin: 4, stamina: 5, reflex: 5, instinct: 7, nerve: 8 }, ability: 'IMMOVABLE' },
  { id: 'robbie', name: 'Robbie', stats: { speed: 5, reach: 6, power: 8, pitch: 5, spin: 5, stamina: 6, reflex: 6, instinct: 6, nerve: 7 }, ability: 'POWER_BASE' },
  { id: 'joe', name: 'Joe', stats: { speed: 2, reach: 2, power: 2, pitch: 3, spin: 2, stamina: 3, reflex: 2, instinct: 2, nerve: 2 }, ability: 'BUTTERFINGERS' },
  { id: 'ricy', name: 'Ricy', stats: { speed: 7, reach: 8, power: 8, pitch: 8, spin: 6, stamina: 8, reflex: 7, instinct: 7, nerve: 7 }, ability: 'POWERHOUSE' },
  { id: 'whale', name: 'The Whale', stats: { speed: 1, reach: 10, power: 10, pitch: 4, spin: 2, stamina: 5, reflex: 3, instinct: 6, nerve: 7 }, ability: 'WALL' },
]);

/** Look up a character by id; unknown ids are a programmer error. */
export function getCharacter(id: string): Character {
  const found = CHARACTERS.find((c) => c.id === id);
  if (found === undefined) throw new RangeError(`unknown character id: ${id}`);
  return found;
}
```

`shared/src/index.ts` — replace with:

```ts
export * from './types';
export * from './constants';
export * from './formulas';
export * from './characters';
```

- [ ] **Step 6: Run to verify pass** — `npx vitest run shared` (expect 39 + 4 new constants + 13 formulas + 5 characters ≈ 61 tests green; exact count in your report) and `npx tsc --noEmit -p shared` clean.

- [ ] **Step 7: Commit**

```bash
git add shared
git commit -m "feat(shared): §5 formulas, §3 roster, input types and milestone 3 tunables"
```

---

### Task 2: PitchModule (parallel-safe with Task 3)

**Files:**
- Create: `server/src/modules/PitchModule.ts`
- Test: `server/test/PitchModule.test.ts`

**Interfaces:**
- Consumes: `CONST`, `StatBlock`, `PitchInput`, `PitchParams`, `pitchSpeed`, `pitchSpin` from `@carlquest/shared`.
- Produces: `resolvePitch(stats: StatBlock, input: PitchInput): PitchParams` — pure; Task 4 calls it and feeds the result to `physics.applyPitch`.

- [ ] **Step 1: Write the failing tests** — create `server/test/PitchModule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONST, getCharacter, pitchSpeed, pitchSpin } from '@carlquest/shared';
import { resolvePitch } from '../src/modules/PitchModule';

const kian = getCharacter('kian');
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('resolvePitch', () => {
  it('velocity magnitude equals pitchSpeed(stats.pitch) (Kian: 26.4 m/s)', () => {
    const p = resolvePitch(kian.stats, { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    expect(len(p.velocity)).toBeCloseTo(pitchSpeed(8), 8);
    expect(len(p.velocity)).toBeCloseTo(26.4, 8);
  });

  it('velocity direction follows the (normalised) aim', () => {
    const p = resolvePitch(kian.stats, { aim: { x: 0, y: 0, z: -2 }, spinInput: 0 });
    expect(p.velocity.x).toBeCloseTo(0, 8);
    expect(p.velocity.z).toBeCloseTo(-26.4, 8);
  });

  it('spin is vertical-axis sidespin scaled by spinInput (Kian spin 9)', () => {
    const p = resolvePitch(kian.stats, { aim: { x: 0, y: 0, z: -1 }, spinInput: 1 });
    expect(p.angularVelocity).toEqual({ x: 0, y: pitchSpin(9, 1), z: 0 });
    const half = resolvePitch(kian.stats, { aim: { x: 0, y: 0, z: -1 }, spinInput: -0.5 });
    expect(half.angularVelocity.y).toBeCloseTo(-pitchSpin(9, 1) * 0.5, 8);
  });

  it('spinInput is clamped to [-1, 1]', () => {
    const p = resolvePitch(kian.stats, { aim: { x: 0, y: 0, z: -1 }, spinInput: 5 });
    expect(p.angularVelocity.y).toBeCloseTo(pitchSpin(9, 1), 8);
  });

  it('zero or non-finite aim defaults towards the batting square', () => {
    for (const aim of [{ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 0 }]) {
      const p = resolvePitch(kian.stats, { aim, spinInput: 0 });
      // Bowling square is +z of the batting square, so a default pitch travels -z.
      expect(p.velocity.z).toBeLessThan(0);
      expect(len(p.velocity)).toBeCloseTo(26.4, 8);
    }
  });

  it('aim elevation is capped at PITCH_ELEVATION_MAX_DEG', () => {
    const p = resolvePitch(kian.stats, { aim: { x: 0, y: 5, z: -1 }, spinInput: 0 });
    const elevation = Math.asin(p.velocity.y / len(p.velocity)) * (180 / Math.PI);
    expect(elevation).toBeLessThanOrEqual(CONST.GAME.PITCH_ELEVATION_MAX_DEG + 1e-9);
  });

  it('origin is the bowling square at release height', () => {
    const p = resolvePitch(kian.stats, { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    expect(p.origin).toEqual({
      x: CONST.FIELD.BOWLING_SQUARE.x,
      y: CONST.PHYSICS.BALL_RELEASE_HEIGHT,
      z: CONST.FIELD.BOWLING_SQUARE.z,
    });
  });

  it('is pure — same inputs, same output, input not mutated', () => {
    const input = { aim: { x: 0.3, y: 0.1, z: -1 }, spinInput: 0.4 };
    const a = resolvePitch(kian.stats, input);
    const b = resolvePitch(kian.stats, input);
    expect(a).toEqual(b);
    expect(input.aim).toEqual({ x: 0.3, y: 0.1, z: -1 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/test/PitchModule.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** — create `server/src/modules/PitchModule.ts`:

```ts
/**
 * Converts pitcher stats + player input into initial ball velocities (spec §1).
 * Pure: all physics application happens in PhysicsModule.
 */
import {
  CONST,
  pitchSpeed,
  pitchSpin,
  type PitchInput,
  type PitchParams,
  type StatBlock,
  type Vec3,
} from '@carlquest/shared';

const { FIELD, PHYSICS, GAME } = CONST;

const DEG_TO_RAD = Math.PI / 180;

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Default aim: from the bowling square towards the batting square at release height. */
function defaultAim(): Vec3 {
  return {
    x: FIELD.BATTING_SQUARE.x - FIELD.BOWLING_SQUARE.x,
    y: 0,
    z: FIELD.BATTING_SQUARE.z - FIELD.BOWLING_SQUARE.z,
  };
}

/** Normalise aim, capping elevation so pitches cannot be lobbed (player input is untrusted). */
function normaliseAim(aim: Vec3, maxElevationDeg: number): Vec3 {
  const usable = isFiniteVec(aim) && Math.hypot(aim.x, aim.y, aim.z) > 1e-9 ? aim : defaultAim();
  const horizontal = Math.hypot(usable.x, usable.z);
  const maxY = horizontal * Math.tan(maxElevationDeg * DEG_TO_RAD);
  const cappedY = Math.min(usable.y, maxY);
  const length = Math.hypot(usable.x, cappedY, usable.z);
  return { x: usable.x / length, y: cappedY / length, z: usable.z / length };
}

export function resolvePitch(stats: StatBlock, input: PitchInput): PitchParams {
  const direction = normaliseAim(input.aim, GAME.PITCH_ELEVATION_MAX_DEG);
  const speed = pitchSpeed(stats.pitch);
  const spinScalar = Math.max(-1, Math.min(1, input.spinInput));
  return {
    origin: {
      x: FIELD.BOWLING_SQUARE.x,
      y: PHYSICS.BALL_RELEASE_HEIGHT,
      z: FIELD.BOWLING_SQUARE.z,
    },
    velocity: { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed },
    // Sidespin about the vertical axis; Magnus turns this into lateral curve.
    // curveMult stays 1 until CURVEBALL_MASTER (Milestone 9).
    angularVelocity: { x: 0, y: pitchSpin(stats.spin, 1) * spinScalar, z: 0 },
  };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/test/PitchModule.test.ts` — 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/PitchModule.ts server/test/PitchModule.test.ts
git commit -m "feat(server): pitch module mapping stats and input to ball velocities"
```

---

### Task 3: HitModule (parallel-safe with Task 2)

**Files:**
- Create: `server/src/modules/HitModule.ts`
- Test: `server/test/HitModule.test.ts`

**Interfaces:**
- Consumes: `CONST`, `StatBlock`, `SwingInput`, `HitParams`, `timingWindow`, `timingFactor`, `exitVelocity`, `hitSpin` from `@carlquest/shared`.
- Produces: `type SwingResult = { contact: true; params: HitParams; timingFactor: number } | { contact: false }` and `resolveSwing(stats: StatBlock, input: SwingInput, timingError: number, windowMult?: number): SwingResult` — pure; Task 4 calls it and feeds `params` to `physics.applyHit`.

- [ ] **Step 1: Write the failing tests** — create `server/test/HitModule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONST, exitVelocity, getCharacter, timingWindow } from '@carlquest/shared';
import { resolveSwing } from '../src/modules/HitModule';

const carl = getCharacter('carl');
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
const FLAT_AIM = { x: 0.5, y: 0, z: 1 };

describe('resolveSwing', () => {
  it('perfect timing gives full exit velocity (Carl power 8: 34 m/s)', () => {
    const r = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0);
    expect(r.contact).toBe(true);
    if (r.contact) {
      expect(len(r.params.velocity)).toBeCloseTo(34, 8);
      expect(r.timingFactor).toBe(1);
    }
  });

  it('error of half the window halves the exit velocity', () => {
    const w = timingWindow(carl.stats.reflex);
    const r = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, w / 2);
    expect(r.contact).toBe(true);
    if (r.contact) {
      expect(r.timingFactor).toBeCloseTo(0.5, 8);
      expect(len(r.params.velocity)).toBeCloseTo(exitVelocity(8, 0.5), 8);
    }
  });

  it('error at or beyond the window is a miss (early and late)', () => {
    const w = timingWindow(carl.stats.reflex);
    expect(resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, w).contact).toBe(false);
    expect(resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, -w - 0.01).contact).toBe(false);
    expect(resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, Number.POSITIVE_INFINITY).contact).toBe(false);
  });

  it('windowMult shrinks the window (CANNON_ARM hook, default 1)', () => {
    const w = timingWindow(carl.stats.reflex);
    const errJustInside = w * 0.9;
    expect(resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errJustInside).contact).toBe(true);
    expect(resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errJustInside, 0.85).contact).toBe(false);
  });

  it('launch elevation is clamped to HIT_ELEVATION_MIN/MAX_DEG', () => {
    const up = resolveSwing(carl.stats, { aim: { x: 0, y: 10, z: 1 }, spinInput: 0 }, 0);
    const down = resolveSwing(carl.stats, { aim: { x: 0, y: -10, z: 1 }, spinInput: 0 }, 0);
    expect(up.contact && down.contact).toBe(true);
    if (up.contact && down.contact) {
      const elev = (v: { x: number; y: number; z: number }) => Math.asin(v.y / len(v)) * (180 / Math.PI);
      expect(elev(up.params.velocity)).toBeLessThanOrEqual(CONST.GAME.HIT_ELEVATION_MAX_DEG + 1e-9);
      expect(elev(down.params.velocity)).toBeGreaterThanOrEqual(CONST.GAME.HIT_ELEVATION_MIN_DEG - 1e-9);
    }
  });

  it('zero aim defaults to a flat drive into the field (positive x-ish, finite)', () => {
    const r = resolveSwing(carl.stats, { aim: { x: 0, y: 0, z: 0 }, spinInput: 0 }, 0);
    expect(r.contact).toBe(true);
    if (r.contact) {
      expect(len(r.params.velocity)).toBeCloseTo(34, 8);
      expect(Number.isFinite(r.params.velocity.x)).toBe(true);
    }
  });

  it('spin follows spinInput sign and Carl spin 5 magnitude, clamped', () => {
    const r = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: -3 }, 0);
    expect(r.contact).toBe(true);
    if (r.contact) {
      expect(r.params.angularVelocity.y).toBeCloseTo(-CONST.GAME.SPIN_MAX_RADS * 0.5, 8);
    }
  });

  it('is pure — repeat calls identical, input unmutated', () => {
    const input = { aim: { x: 1, y: 0.5, z: 1 }, spinInput: 0.3 };
    expect(resolveSwing(carl.stats, input, 0.02)).toEqual(resolveSwing(carl.stats, input, 0.02));
    expect(input.aim).toEqual({ x: 1, y: 0.5, z: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/test/HitModule.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** — create `server/src/modules/HitModule.ts`:

```ts
/**
 * Resolves a batter swing against server-computed timing (spec §1, §5).
 * Pure: timing error is supplied by MatchRoom; physics application is PhysicsModule's.
 */
import {
  CONST,
  exitVelocity,
  hitSpin,
  timingFactor,
  timingWindow,
  type HitParams,
  type StatBlock,
  type SwingInput,
  type Vec3,
} from '@carlquest/shared';

const { GAME } = CONST;
const DEG_TO_RAD = Math.PI / 180;

export type SwingResult =
  | { contact: true; params: HitParams; timingFactor: number }
  | { contact: false };

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Default: a flat-ish drive towards mid-field, between posts 1 and 2. */
function defaultAim(): Vec3 {
  const p1 = GAMEFIELD_POST(0);
  const p2 = GAMEFIELD_POST(1);
  return { x: (p1.x + p2.x) / 2, y: 0, z: (p1.z + p2.z) / 2 };
}

function GAMEFIELD_POST(i: number): { x: number; z: number } {
  const post = CONST.FIELD.POSTS[i];
  if (post === undefined) throw new RangeError(`no post ${i}`);
  return post;
}

/** Normalise aim, clamping elevation to the tunable hit range (user-approved M3 decision). */
function normaliseAim(aim: Vec3): Vec3 {
  const usable = isFiniteVec(aim) && Math.hypot(aim.x, aim.y, aim.z) > 1e-9 ? aim : defaultAim();
  const horizontal = Math.hypot(usable.x, usable.z);
  const minY = horizontal * Math.tan(GAME.HIT_ELEVATION_MIN_DEG * DEG_TO_RAD);
  const maxY = horizontal * Math.tan(GAME.HIT_ELEVATION_MAX_DEG * DEG_TO_RAD);
  const clampedY = Math.min(maxY, Math.max(minY, usable.y));
  const length = Math.hypot(usable.x, clampedY, usable.z);
  return { x: usable.x / length, y: clampedY / length, z: usable.z / length };
}

export function resolveSwing(
  stats: StatBlock,
  input: SwingInput,
  timingError: number,
  windowMult = 1, // CANNON_ARM shrinks the batter's window in Milestone 9
): SwingResult {
  const window = timingWindow(stats.reflex, windowMult);
  const timing = timingFactor(timingError, window);
  if (timing <= 0) return { contact: false };

  const direction = normaliseAim(input.aim);
  const speed = exitVelocity(stats.power, timing);
  const spinScalar = Math.max(-1, Math.min(1, input.spinInput));
  return {
    contact: true,
    timingFactor: timing,
    params: {
      velocity: { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed },
      // hitCurveMult stays 1 until abilities (Milestone 9).
      angularVelocity: { x: 0, y: hitSpin(stats.spin, 1) * spinScalar, z: 0 },
    },
  };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run server/test/HitModule.test.ts` — 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/HitModule.ts server/test/HitModule.test.ts
git commit -m "feat(server): hit module resolving timed swings via §5 formulas"
```

---

### Task 4: MatchRoom demo loop (sim tick, ball sync, pitch/swing messages)

**Files:**
- Modify: `server/src/rooms/MatchState.ts`, `server/src/rooms/MatchRoom.ts`
- Test: `server/test/MatchRoom.test.ts` (append)

**Interfaces:**
- Consumes: `createPhysicsModule`/`PhysicsModule` (M2), `resolvePitch` (Task 2), `resolveSwing` (Task 3), `getCharacter`, `CONST`, `PitchInput`, `SwingInput`.
- Produces: synced `MatchState.ball: BallSchema { x y z vx vy vz wx wy wz }`, `MatchState.ballLive: boolean`, `MatchState.demoLog: string`; message handlers `'pitch'` (PitchInput) and `'swing'` ({ timing: number } & SwingInput — timing accepted but ignored in M3, logged decision). Demo cast: pitcher Kian, batter Carl.

- [ ] **Step 1: Write the failing integration tests** — append inside the existing describe in `server/test/MatchRoom.test.ts` (reuse the existing `colyseus` boot):

```ts
  it('pitch while idle makes the ball live with stat-derived speed', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await client.waitForNextPatch();
    expect(client.state.ballLive).toBe(true);
    const speed = Math.hypot(client.state.ball.vx, client.state.ball.vy, client.state.ball.vz);
    expect(speed).toBeGreaterThan(20); // Kian pitch 8 → 26.4 m/s minus a tick of damping/gravity coupling
    expect(speed).toBeLessThan(27);
  });

  it('rejects a second pitch while the ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    const before = { ...room.state.ball };
    client.send('pitch', { aim: { x: 1, y: 0, z: 0 }, spinInput: 1 });
    await room.waitForNextSimulationTick();
    // Velocity direction unchanged (second pitch ignored; ball still travelling -z)
    expect(room.state.ball.vz).toBeLessThan(0);
    expect(Math.sign(room.state.ball.vx)).toBe(Math.sign(before.vx));
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a swing when no ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('full loop: pitch, wait for plane crossing, swing connects and reverses flight', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    // Ball travels ~7.5 m at ~26.4 m/s ≈ 0.284 s ≈ 17 ticks. Poll until it nears the plane.
    for (let i = 0; i < 60; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ball.z < 0.5) break;
    }
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await room.waitForNextSimulationTick();
    // A connected hit sends the ball back out (+z-ish per the demo aim) at hit speed.
    expect(room.state.ball.vz).toBeGreaterThan(0);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(10);
  }, 15000);
```

(If `waitForNextSimulationTick` is not available on the room handle in `@colyseus/testing`, poll with a short `new Promise((r) => setTimeout(r, 20))` loop instead and note the substitution in your report — but check the installed API first.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/test/MatchRoom.test.ts` — new tests FAIL.

- [ ] **Step 3: Implement.** `server/src/rooms/MatchState.ts` — replace contents with:

```ts
import { Schema, type } from '@colyseus/schema';
import type { MatchPhase } from '@carlquest/shared';

export class BallSchema extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') vx = 0;
  @type('number') vy = 0;
  @type('number') vz = 0;
  @type('number') wx = 0;
  @type('number') wy = 0;
  @type('number') wz = 0;
}

export class MatchState extends Schema {
  @type('string') phase: MatchPhase = 'LOBBY';
  @type(BallSchema) ball = new BallSchema();
  @type('boolean') ballLive = false;
  /** Dev-visible log line for the M3 demo (rejections, outcomes). Replaced by real events in M5+. */
  @type('string') demoLog = '';
}
```

`server/src/rooms/MatchRoom.ts` — replace contents with:

```ts
import { Room, type Client } from '@colyseus/core';
import {
  CONST,
  getCharacter,
  type PitchInput,
  type SwingInput,
} from '@carlquest/shared';
import { createPhysicsModule, type PhysicsModule } from '../modules/PhysicsModule';
import { resolvePitch } from '../modules/PitchModule';
import { resolveSwing } from '../modules/HitModule';
import { MatchState } from './MatchState';

const { PHYSICS, GAME, FIELD } = CONST;

/** Demo cast for the M3 single-player loop; the draft replaces this in Milestone 7. */
const DEMO_PITCHER = getCharacter('kian');
const DEMO_BATTER = getCharacter('carl');

type SwingMessage = SwingInput & { timing: number };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isVec3(v: unknown): v is { x: number; y: number; z: number } {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return isFiniteNumber(c.x) && isFiniteNumber(c.y) && isFiniteNumber(c.z);
}

/** Authoritative match room. M3: single-player pitch→swing demo loop. */
export class MatchRoom extends Room<MatchState> {
  override maxClients = 2;

  private physics!: PhysicsModule;
  private simTime = 0;
  /** Sim-time when the live ball crossed the batting-square plane; null until it does. */
  private contactTime: number | null = null;
  private crossed = false;
  private swung = false;
  private liveSince = 0;
  private restSince: number | null = null;

  override async onCreate(): Promise<void> {
    this.setState(new MatchState());
    this.physics = await createPhysicsModule();

    this.onMessage('pitch', (client, message) => this.handlePitch(client, message));
    this.onMessage('swing', (client, message) => this.handleSwing(client, message));

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / 60);
  }

  override onJoin(client: Client): void {
    console.log(`client ${client.sessionId} joined`);
  }

  override onLeave(client: Client): void {
    console.log(`client ${client.sessionId} left`);
  }

  override onDispose(): void {
    this.physics.dispose();
  }

  private handlePitch(_client: Client, message: unknown): void {
    const m = message as Partial<PitchInput>;
    if (this.state.ballLive || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.state.demoLog = 'pitch rejected (ball live or malformed input)';
      return;
    }
    const params = resolvePitch(DEMO_PITCHER.stats, { aim: m.aim, spinInput: m.spinInput });
    this.physics.applyPitch(params);
    this.state.ballLive = true;
    this.state.demoLog = 'pitch away';
    this.contactTime = null;
    this.crossed = false;
    this.swung = false;
    this.liveSince = this.simTime;
    this.restSince = null;
  }

  private handleSwing(_client: Client, message: unknown): void {
    const m = message as Partial<SwingMessage>;
    // M3 decision: the client 'timing' field is accepted but ignored; the server's
    // own sim-time is authoritative. Revisit for latency compensation in Milestone 6.
    if (!this.state.ballLive || this.swung || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.state.demoLog = 'swing rejected (no live pitch, already swung, or malformed input)';
      return;
    }
    const error = this.timingErrorNow();
    if (error === null) {
      this.state.demoLog = 'swing rejected (ball never reaches the batter)';
      return;
    }
    this.swung = true;
    const result = resolveSwing(DEMO_BATTER.stats, { aim: m.aim, spinInput: m.spinInput }, error);
    if (!result.contact) {
      this.state.demoLog = `swing missed (timing error ${error.toFixed(3)} s)`;
      return;
    }
    this.physics.applyHit(result.params);
    this.state.demoLog = `hit! timing factor ${result.timingFactor.toFixed(2)}`;
  }

  /** Signed swing-timing error: positive = late, negative = early; null if no contact possible. */
  private timingErrorNow(): number | null {
    if (this.contactTime !== null) return this.simTime - this.contactTime;
    const ball = this.physics.getBallState();
    const dz = ball.position.z - FIELD.BATTING_SQUARE.z;
    if (ball.velocity.z >= 0) return null; // moving away — will never cross
    const timeToPlane = dz / -ball.velocity.z;
    return -timeToPlane; // early by the projected time remaining
  }

  private tick(deltaMs: number): void {
    // Clamp to avoid a spiral-of-death catch-up burst after an event-loop stall (§6.4 M2 item).
    const dt = Math.min(deltaMs / 1000, PHYSICS.SIM_MAX_CATCHUP);
    this.simTime += dt;
    if (!this.state.ballLive) return;

    const before = this.physics.getBallState().position.z;
    this.physics.step(dt);
    const state = this.physics.getBallState();

    // Record the moment the ball first crosses the batting-square plane (ideal contact).
    if (!this.crossed && before > FIELD.BATTING_SQUARE.z && state.position.z <= FIELD.BATTING_SQUARE.z) {
      this.crossed = true;
      this.contactTime = this.simTime;
    }

    this.state.ball.x = state.position.x;
    this.state.ball.y = state.position.y;
    this.state.ball.z = state.position.z;
    this.state.ball.vx = state.velocity.x;
    this.state.ball.vy = state.velocity.y;
    this.state.ball.vz = state.velocity.z;
    this.state.ball.wx = state.angularVelocity.x;
    this.state.ball.wy = state.angularVelocity.y;
    this.state.ball.wz = state.angularVelocity.z;

    this.endPlayIfOver(state);
  }

  private endPlayIfOver(state: { velocity: { x: number; y: number; z: number } }): void {
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    if (speed < GAME.BALL_REST_SPEED) {
      this.restSince ??= this.simTime;
    } else {
      this.restSince = null;
    }
    const timedOut = this.simTime - this.liveSince > GAME.PLAY_TIMEOUT_S;
    const atRest = this.restSince !== null && this.simTime - this.restSince > GAME.BALL_REST_TIME_S;
    if (timedOut || atRest) {
      this.state.ballLive = false;
      this.state.demoLog = `play over (${timedOut ? 'timeout' : 'ball at rest'}) — press P to pitch`;
      this.physics.spawnBall();
    }
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run server` — all suites green (MatchRoom now 6 tests, PhysicsModule 16, PitchModule 8, HitModule 8). `npx tsc --noEmit -p server` clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/rooms server/test/MatchRoom.test.ts
git commit -m "feat(server): single-player pitch/swing demo loop with synced ball state"
```

---

### Task 5: Client — join room, render ball, send inputs

**Files:**
- Modify: `client/package.json` (add `"colyseus.js": "^0.15.0"` to dependencies; run `npm install` from repo root), `client/src/main.ts`, `client/index.html`
- Create: `client/src/NetModule.ts`, `client/src/RenderModule.ts`, `client/src/InputModule.ts`

**Interfaces:**
- Consumes: `createScene` (M1), schema shape from Task 4 (`state.ball.{x,y,z}`, `state.ballLive`, `state.demoLog`), `CONST.PHYSICS.BALL_RADIUS`.
- Produces: a playable demo page. No exports consumed by later tasks (M6 will grow NetModule).

- [ ] **Step 1: Implement (no unit tests — client is render/IO glue; verification is the typecheck, lint, build, and the manual acceptance run).**

`client/index.html` — add inside `<body>` before the script tag:

```html
    <pre id="status">connecting…</pre>
```

and in the `<style>` block:

```css
      #status { position: fixed; top: 8px; left: 8px; margin: 0; color: #f5f1e6; font: 14px monospace; }
```

Create `client/src/NetModule.ts`:

```ts
/** Colyseus connection (grows into the full NetModule in Milestone 6). */
import { Client, type Room } from 'colyseus.js';
import type { PitchInput, SwingInput } from '@carlquest/shared';

const SERVER_URL = `ws://${location.hostname}:2567`;

export interface Net {
  room: Room;
  sendPitch(input: PitchInput): void;
  sendSwing(input: SwingInput & { timing: number }): void;
}

export async function connect(): Promise<Net> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate('match');
  return {
    room,
    sendPitch(input) {
      room.send('pitch', input);
    },
    sendSwing(input) {
      room.send('swing', input);
    },
  };
}
```

Create `client/src/RenderModule.ts`:

```ts
/** Syncs render meshes to authoritative state (grows in later milestones). */
import * as THREE from 'three';
import { CONST } from '@carlquest/shared';

export interface BallView {
  /** Call once per frame with the latest authoritative ball position. */
  update(x: number, y: number, z: number, visible: boolean): void;
}

export function createBallView(scene: THREE.Scene): BallView {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(CONST.PHYSICS.BALL_RADIUS * 4, 16, 12), // ×4: a real 3.6 cm ball is invisible at field scale
    new THREE.MeshLambertMaterial({ color: 0xe8483f }),
  );
  mesh.visible = false;
  scene.add(mesh);
  const target = new THREE.Vector3();
  return {
    update(x, y, z, visible) {
      target.set(x, y, z);
      // Light smoothing towards the latest authoritative position (no client physics).
      mesh.position.lerp(target, 0.5);
      mesh.visible = visible;
    },
  };
}
```

Create `client/src/InputModule.ts`:

```ts
/** Keyboard → server messages for the M3 demo. Real input UI arrives with later milestones. */
import type { Net } from './NetModule';

// Demo aim constants: pitch at the batter; hit flat-ish towards mid-field (posts 1-2 gap).
const PITCH_AIM = { x: 0, y: 0, z: -1 };
const HIT_AIM = { x: 0.55, y: 0.47, z: 0.65 }; // ≈25° elevation towards mid-field

export interface InputState {
  spin: number;
}

export function attachInput(net: Net, onLocalAction: (text: string) => void): InputState {
  const state: InputState = { spin: 0 };
  window.addEventListener('keydown', (event) => {
    switch (event.code) {
      case 'KeyA':
        state.spin = -1;
        onLocalAction('spin set: -1 (left)');
        break;
      case 'KeyS':
        state.spin = 0;
        onLocalAction('spin set: 0 (straight)');
        break;
      case 'KeyD':
        state.spin = 1;
        onLocalAction('spin set: +1 (right)');
        break;
      case 'KeyP':
        net.sendPitch({ aim: PITCH_AIM, spinInput: state.spin });
        break;
      case 'Space':
        event.preventDefault();
        net.sendSwing({ timing: 0, aim: HIT_AIM, spinInput: 0 });
        break;
      default:
    }
  });
  return state;
}
```

`client/src/main.ts` — replace with:

```ts
import { createScene } from './SceneModule';
import { connect } from './NetModule';
import { createBallView } from './RenderModule';
import { attachInput } from './InputModule';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLPreElement>('#status');
if (!canvas || !status) throw new Error('Missing #app canvas or #status line');

const { scene, start } = createScene(canvas);
const ball = createBallView(scene);
start();

const HELP = 'A/S/D spin · P pitch · Space swing';

connect()
  .then((net) => {
    status.textContent = `connected — ${HELP}`;
    attachInput(net, (text) => {
      status.textContent = `${text} — ${HELP}`;
    });
    net.room.onStateChange((state) => {
      ball.update(state.ball.x, state.ball.y, state.ball.z, state.ballLive);
      if (state.demoLog) status.textContent = `${state.demoLog} — ${HELP}`;
    });
  })
  .catch((error: unknown) => {
    status.textContent = `connection failed: ${String(error)} — is the server running?`;
  });
```

(Note: `createScene` currently returns `{ scene, camera, renderer, start }` — destructure only what is used. `room.onStateChange` state is untyped in colyseus.js without generated schema types; type it as the runtime shape with a local interface rather than `any`, e.g. `interface DemoState { ball: { x: number; y: number; z: number }; ballLive: boolean; demoLog: string }` and `net.room.onStateChange((state: DemoState) => …)` — colyseus.js accepts a typed callback. If the installed colyseus.js signature differs, adapt while keeping strict typing without `any`.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit -p client` clean; `npx eslint client` clean; `npm run build -w @carlquest/client` succeeds.

- [ ] **Step 3: Commit**

```bash
git add client
git commit -m "feat(client): join match room, render live ball, keyboard pitch/swing"
```

---

### Task 6: Full verification, acceptance demo, project log

**Files:**
- Modify: `CLAUDE.md` (§6)

- [ ] **Step 1:** `npm run check` — expected all green (≈ shared 61, server 38, client 0 — record exact counts).
- [ ] **Step 2 (controller):** `npm run dev`; verify in a real/headless browser: P pitches (ball flies in, curves with A/D spin), Space during the window hits the ball back out, status line narrates. Screenshot evidence.
- [ ] **Step 3:** Update CLAUDE.md §6.1 (M3 state), §6.2 (decisions: aim-based launch angle user-approved; swing `timing` field ignored server-side in M3; demo cast Kian/Carl; 7 new tunables; sidespin-only input mapping), §6.3 changelog with evidence, §6.4 (remove the `step()` clamp item — closed by SIM_MAX_CATCHUP; add anything new).
- [ ] **Step 4:** Commit `docs: record milestone 3 completion in project log`; merge + tag `m3-pitch-hit` happens via finishing-a-development-branch.

---

## Self-Review Notes

- Spec coverage: §5 all formulas ✓ Task 1 (incl. ones consumed later: moveSpeed/catchRadius/pCatch/fatigueMult/pressureMult — CLAUDE.md mandates formulas.ts complete); §3 roster ✓ Task 1; §1 PitchModule/HitModule ✓ Tasks 2-3 (pure, feeding PhysicsModule per interface); §7 message names/payloads ✓ Task 4 (validation is M3-minimal, logged); §9.3 acceptance ✓ Tasks 4 (integration test) + 6 (manual). Launch angle = user-approved aim-based decision.
- Type consistency: `SwingResult` defined Task 3, consumed Task 4; `PitchInput`/`SwingInput` defined Task 1, used Tasks 2-5; schema field names (`ball.vx` etc.) consistent between Tasks 4 and 5; `timingWindow(reflex, windowMult?)` signature consistent Task 1/3.
- Parallelism: Tasks 2 and 3 share no files and may run concurrently; all other tasks sequential.
- Known API risks: `@colyseus/testing` room helpers (`waitForNextSimulationTick`) and colyseus.js state typing — both flagged inline with fallback instructions.
