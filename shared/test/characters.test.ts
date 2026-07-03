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

  // vitest's it.each types fall back to a flattened union array for tuples >10 columns
  // wide; this cast recovers the per-column types the test data actually has.
  it.each(SPEC_ROWS)('pins %s exactly', (...row: unknown[]) => {
    const [id, name, spd, rch, pow, pit, spn, sta, rfx, ins, nrv, ability] = row as unknown as [
      string, string, number, number, number, number, number, number, number, number, number, string,
    ];
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
