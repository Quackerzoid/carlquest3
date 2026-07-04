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
