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
    const onlyCharacter = CHARACTERS[0];
    if (onlyCharacter === undefined) throw new Error('empty roster');
    const draft = createDraftModule([onlyCharacter], picksEach(1));
    expect(draft.view().complete).toBe(true);
    expect(draft.view().turn).toBeNull();
  });
});
