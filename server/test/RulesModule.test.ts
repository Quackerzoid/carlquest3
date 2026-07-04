import { describe, expect, it } from 'vitest';
import { CONST, type Character, type PlayOutcome, type SettlementFact } from '@carlquest/shared';
import { createRulesModule } from '../src/modules/RulesModule';

// ---------------------------------------------------------------------------
// Helpers. RulesModule reads only `character.id` (batting order = array order);
// stats/ability are never touched, so test characters can be minimal.
// ---------------------------------------------------------------------------

function char(id: string): Character {
  return {
    id,
    name: id,
    stats: { speed: 1, reach: 1, power: 1, pitch: 1, spin: 1, stamina: 1, reflex: 1, instinct: 1, nerve: 1 },
    ability: 'WALL',
  };
}

function squad(...ids: string[]): Character[] {
  return ids.map(char);
}

function fact(
  runnerId: string,
  opts: { ownHit?: boolean; highestPost?: number; home?: boolean; out?: boolean } = {},
): SettlementFact {
  return {
    runnerId,
    ownHit: opts.ownHit ?? false,
    highestPost: opts.highestPost ?? 0,
    home: opts.home ?? false,
    out: opts.out ?? false,
  };
}

const SAFE: PlayOutcome = { kind: 'safe', atPost: 1, runnerId: 'x' };
const ROUNDER: PlayOutcome = { kind: 'rounder' };

type Rules = ReturnType<typeof createRulesModule>;

/** LOBBY → PRE_PLAY (innings 0, batting side A up, first batter ready). play() then readies for each play. */
function drive(rules: Rules): void {
  expect(rules.bothConnected()).toBe(true);
  expect(rules.completeDraft()).toBe(true);
  expect(rules.confirmPositioning()).toBe(true);
  expect(rules.view().phase).toBe('PRE_PLAY');
}

/** From PRE_PLAY: ready + resolve one play, returning the resolution. */
function play(rules: Rules, cause: PlayOutcome, facts: SettlementFact[]) {
  expect(rules.readyForPlay()).toBe(true);
  const res = rules.resolvePlay(cause, facts);
  expect(res).not.toBeNull();
  return res;
}

// ---------------------------------------------------------------------------

describe('RulesModule — phase machine', () => {
  it('walks LOBBY → … → GAME_OVER → rematch → INITIAL_POSITIONING (happy path)', () => {
    // Single-player squads, one innings pair. A scores a rounder then is caught
    // (innings ends, all out); B parks and strands → A wins 2–0.
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1'), inningsCount: 1 });

    expect(rules.view().phase).toBe('LOBBY');
    expect(rules.bothConnected()).toBe(true);
    expect(rules.view().phase).toBe('DRAFT');
    expect(rules.completeDraft()).toBe(true);
    expect(rules.view().phase).toBe('INITIAL_POSITIONING');
    expect(rules.confirmPositioning()).toBe(true);
    expect(rules.view().phase).toBe('PRE_PLAY');
    expect(rules.view().battingSide).toBe('A');
    expect(rules.view().currentBatterId).toBe('a1');

    // Play 1: a1 homes on own hit → 2 halves; a1 rejoins queue → bats again.
    play(rules, ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]);
    expect(rules.view().phase).toBe('PRE_PLAY');
    expect(rules.view().scoreHalves.A).toBe(2);
    expect(rules.view().currentBatterId).toBe('a1');

    // Play 2: a1 caught → out; queue empty → innings ends → B bats.
    play(rules, { kind: 'caught', by: 'f1' }, [fact('a1', { ownHit: true, highestPost: 2 })]);
    expect(rules.view().phase).toBe('PRE_PLAY');
    expect(rules.view().battingSide).toBe('B');
    expect(rules.view().outs).toBe(0); // reset for the new innings
    expect(rules.view().currentBatterId).toBe('b1');

    // Innings B: b1 parks and strands → innings ends → last innings → A wins.
    play(rules, SAFE, [fact('b1', { ownHit: true, highestPost: 1 })]);
    expect(rules.view().phase).toBe('GAME_OVER');
    expect(rules.view().winner).toBe('A');
    expect(rules.view().scoreHalves).toEqual({ A: 2, B: 0 });

    // rematch → INITIAL_POSITIONING, everything reset except squads.
    expect(rules.rematch()).toBe(true);
    const v = rules.view();
    expect(v.phase).toBe('INITIAL_POSITIONING');
    expect(v.scoreHalves).toEqual({ A: 0, B: 0 });
    expect(v.outs).toBe(0);
    expect(v.inningsIndex).toBe(0);
    expect(v.battingSide).toBe('A');
    expect(v.currentBatterId).toBe('a1');
    expect(v.tiebreak).toBe(false);
    expect(v.winner).toBeNull();
  });

  it('returns false / null for every transition method called out of phase', () => {
    // At LOBBY only bothConnected is legal.
    const r = createRulesModule({ squadA: squad('a1'), squadB: squad('b1') });
    expect(r.completeDraft()).toBe(false);
    expect(r.confirmPositioning()).toBe(false);
    expect(r.readyForPlay()).toBe(false);
    expect(r.rematch()).toBe(false);
    expect(r.resolvePlay(SAFE, [])).toBeNull();
    expect(r.view().phase).toBe('LOBBY'); // nothing changed

    // At DRAFT only completeDraft is legal.
    r.bothConnected();
    expect(r.bothConnected()).toBe(false);
    expect(r.confirmPositioning()).toBe(false);
    expect(r.readyForPlay()).toBe(false);
    expect(r.rematch()).toBe(false);
    expect(r.resolvePlay(SAFE, [])).toBeNull();
    expect(r.view().phase).toBe('DRAFT');

    // At INITIAL_POSITIONING only confirmPositioning is legal.
    r.completeDraft();
    expect(r.bothConnected()).toBe(false);
    expect(r.completeDraft()).toBe(false);
    expect(r.readyForPlay()).toBe(false);
    expect(r.rematch()).toBe(false);
    expect(r.resolvePlay(SAFE, [])).toBeNull();
    expect(r.view().phase).toBe('INITIAL_POSITIONING');

    // At PRE_PLAY only readyForPlay is legal.
    r.confirmPositioning();
    expect(r.bothConnected()).toBe(false);
    expect(r.completeDraft()).toBe(false);
    expect(r.confirmPositioning()).toBe(false);
    expect(r.rematch()).toBe(false);
    expect(r.resolvePlay(SAFE, [])).toBeNull();
    expect(r.view().phase).toBe('PRE_PLAY');

    // At PLAY only resolvePlay is legal.
    r.readyForPlay();
    expect(r.bothConnected()).toBe(false);
    expect(r.completeDraft()).toBe(false);
    expect(r.confirmPositioning()).toBe(false);
    expect(r.readyForPlay()).toBe(false);
    expect(r.rematch()).toBe(false);
    expect(r.view().phase).toBe('PLAY');
  });
});

describe('RulesModule — scoring table', () => {
  function scoreOf(cause: PlayOutcome, facts: SettlementFact[]) {
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1') });
    drive(rules);
    return play(rules, cause, facts);
  }

  it('own-hit home in one play = 2 halves', () => {
    const res = scoreOf(ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]);
    expect(res?.scoreDeltaHalves).toBe(2);
  });

  it('own-hit reaching post 2 (not home) = 1 half', () => {
    const res = scoreOf(SAFE, [fact('a1', { ownHit: true, highestPost: 2 })]);
    expect(res?.scoreDeltaHalves).toBe(1);
  });

  it('own-hit reaching post 3 (not home) = 1 half', () => {
    const res = scoreOf(SAFE, [fact('a1', { ownHit: true, highestPost: 3 })]);
    expect(res?.scoreDeltaHalves).toBe(1);
  });

  it('own-hit reaching only post 1 = 0', () => {
    const res = scoreOf(SAFE, [fact('a1', { ownHit: true, highestPost: 1 })]);
    expect(res?.scoreDeltaHalves).toBe(0);
  });

  it('later-play circuit completion (not own hit) = 0', () => {
    const res = scoreOf(SAFE, [
      fact('prev', { ownHit: false, home: true, highestPost: 4 }),
      fact('a1', { ownHit: true, highestPost: 1 }),
    ]);
    expect(res?.scoreDeltaHalves).toBe(0);
  });

  it('caught = 0 and puts the batter out (no half banked even if post ≥ 2 reached)', () => {
    const res = scoreOf({ kind: 'caught', by: 'f1' }, [fact('a1', { ownHit: true, highestPost: 3 })]);
    expect(res?.scoreDeltaHalves).toBe(0);
    expect(res?.outs).toContain('a1');
  });

  it('runOut puts the named runner out', () => {
    const res = scoreOf({ kind: 'runOut', atPost: 2, runnerId: 'prev' }, [
      fact('prev', { ownHit: false, highestPost: 2 }),
      fact('a1', { ownHit: true, highestPost: 1 }),
    ]);
    expect(res?.outs).toContain('prev');
  });

  it('sums halves across multiple home runners in one play', () => {
    // own-hit batter homes (2) + a prior runner completing (0) → total 2.
    const res = scoreOf(ROUNDER, [
      fact('a1', { ownHit: true, home: true, highestPost: 4 }),
      fact('prev', { ownHit: false, home: true, highestPost: 4 }),
    ]);
    expect(res?.scoreDeltaHalves).toBe(2);
  });

  it('a facts-flagged out banks nothing for that runner', () => {
    const res = scoreOf(SAFE, [fact('a1', { ownHit: true, highestPost: 3, out: true })]);
    expect(res?.scoreDeltaHalves).toBe(0);
    expect(res?.outs).toContain('a1');
  });
});

describe('RulesModule — batting queue', () => {
  it('a home runner bats again; an out player is skipped', () => {
    const rules = createRulesModule({ squadA: squad('a1', 'a2'), squadB: squad('b1') });
    drive(rules);
    expect(rules.view().currentBatterId).toBe('a1');

    // a1 homes → rejoins back of queue [a2, a1] → next batter a2.
    play(rules, ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]);
    expect(rules.view().currentBatterId).toBe('a2');
    expect(rules.view().scoreHalves.A).toBe(2);

    // a2 caught (out, skipped) → next batter is a1 (bats again).
    play(rules, { kind: 'caught', by: 'f1' }, [fact('a2', { ownHit: true, highestPost: 1 })]);
    expect(rules.view().currentBatterId).toBe('a1');
    expect(rules.view().outs).toBe(1);
  });

  it('runOut of a previous play’s runner leaves the current batter unaffected', () => {
    const rules = createRulesModule({ squadA: squad('a1', 'a2', 'a3'), squadB: squad('b1') });
    drive(rules);
    // Play 1: a1 parks (becomes a previous-play runner), a2 comes up.
    play(rules, SAFE, [fact('a1', { ownHit: true, highestPost: 1 })]);
    expect(rules.view().currentBatterId).toBe('a2');

    // Play 2: a1 (previous runner) is run out; batter a2 is untouched, a3 next? No —
    // a2 parks (not out/home) so next batter is a3.
    const res = play(rules, { kind: 'runOut', atPost: 2, runnerId: 'a1' }, [
      fact('a1', { ownHit: false, highestPost: 2 }),
      fact('a2', { ownHit: true, highestPost: 1 }),
    ]);
    expect(res?.outs).toEqual(['a1']);
    expect(rules.view().outs).toBe(1);
    expect(rules.view().currentBatterId).toBe('a3');
  });
});

describe('RulesModule — innings end', () => {
  it('ends the innings when the batting side is all out (scores stay)', () => {
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1'), inningsCount: 2 });
    drive(rules);
    play(rules, { kind: 'caught', by: 'f1' }, [fact('a1', { ownHit: true, highestPost: 3 })]);
    // a1 out → queue empty → innings ends → B bats; A banked nothing (caught).
    expect(rules.view().battingSide).toBe('B');
    expect(rules.view().scoreHalves.A).toBe(0);
    expect(rules.view().outs).toBe(0);
    expect(rules.view().phase).toBe('PRE_PLAY');
  });

  it('ends the innings when the queue empties with a stranded runner (scores 0)', () => {
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1'), inningsCount: 2 });
    drive(rules);
    // a1 parks on post 1, no one left to bat → innings ends; stranded, scores 0.
    play(rules, SAFE, [fact('a1', { ownHit: true, highestPost: 1 })]);
    expect(rules.view().battingSide).toBe('B');
    expect(rules.view().scoreHalves.A).toBe(0);
  });
});

describe('RulesModule — innings order & side swap', () => {
  it('bats A, B, A, B with INNINGS_COUNT = 2', () => {
    expect(CONST.GAME.INNINGS_COUNT).toBe(2);
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1') }); // default inningsCount
    drive(rules);
    const sides: string[] = [rules.view().battingSide];
    const indices: number[] = [rules.view().inningsIndex];
    // Each single-player innings ends after one park play.
    for (let i = 0; i < 3; i += 1) {
      play(rules, SAFE, [fact(rules.view().currentBatterId ?? 'x', { ownHit: true, highestPost: 1 })]);
      sides.push(rules.view().battingSide);
      indices.push(rules.view().inningsIndex);
    }
    expect(sides).toEqual(['A', 'B', 'A', 'B']);
    expect(indices).toEqual([0, 1, 2, 3]);
  });
});

describe('RulesModule — isFinalInnings & pressure', () => {
  it('isFinalInnings is true only in the last A/B pair (and any tiebreak)', () => {
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1') }); // inningsCount 2 → slots 0..3
    drive(rules);
    const flags: boolean[] = [rules.isFinalInnings()]; // innings 0
    for (let i = 0; i < 3; i += 1) {
      play(rules, SAFE, [fact(rules.view().currentBatterId ?? 'x', { ownHit: true, highestPost: 1 })]);
      flags.push(rules.isFinalInnings());
    }
    expect(flags).toEqual([false, false, true, true]); // innings 0,1,2,3
  });

  it('pressure() = final innings OR runners on 2+ posts', () => {
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1') });
    drive(rules); // innings 0, not final
    expect(rules.isFinalInnings()).toBe(false);
    expect(rules.pressure(0)).toBe(false);
    expect(rules.pressure(1)).toBe(false);
    expect(rules.pressure(2)).toBe(true);

    // Advance to innings 2 (final).
    play(rules, SAFE, [fact('a1', { ownHit: true, highestPost: 1 })]); // → innings 1 (B)
    play(rules, SAFE, [fact('b1', { ownHit: true, highestPost: 1 })]); // → innings 2 (A)
    expect(rules.isFinalInnings()).toBe(true);
    expect(rules.pressure(0)).toBe(true);
  });
});

describe('RulesModule — tiebreak (sudden death)', () => {
  function toTiebreak(): Rules {
    // inningsCount 1 → slots A(0), B(1); both park scoreless → 0–0 tie → tiebreak.
    const rules = createRulesModule({ squadA: squad('a1'), squadB: squad('b1'), inningsCount: 1 });
    drive(rules);
    play(rules, SAFE, [fact('a1', { ownHit: true, highestPost: 1 })]); // A innings ends 0
    play(rules, SAFE, [fact('b1', { ownHit: true, highestPost: 1 })]); // B innings ends 0 → tiebreak
    return rules;
  }

  it('a 0–0 game after the last innings enters tiebreak', () => {
    const rules = toTiebreak();
    expect(rules.view().tiebreak).toBe(true);
    expect(rules.view().phase).toBe('PRE_PLAY');
    expect(rules.view().battingSide).toBe('A');
    expect(rules.isFinalInnings()).toBe(true);
    expect(rules.view().winner).toBeNull();
  });

  it('first differential pair wins (A scores, B does not)', () => {
    const rules = toTiebreak();
    play(rules, ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]); // A +2
    expect(rules.view().tiebreak).toBe(true);
    expect(rules.view().battingSide).toBe('B'); // alternate
    expect(rules.view().winner).toBeNull(); // pair not complete
    play(rules, SAFE, [fact('b1', { ownHit: true, highestPost: 1 })]); // B +0 → pair differs
    expect(rules.view().phase).toBe('GAME_OVER');
    expect(rules.view().winner).toBe('A');
    expect(rules.view().scoreHalves).toEqual({ A: 2, B: 0 });
  });

  it('a tied pair continues into a further pair until broken', () => {
    const rules = toTiebreak();
    play(rules, ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]); // A 2
    play(rules, ROUNDER, [fact('b1', { ownHit: true, home: true, highestPost: 4 })]); // B 2 → pair tied
    expect(rules.view().phase).toBe('PRE_PLAY'); // continues
    expect(rules.view().battingSide).toBe('A');
    expect(rules.view().winner).toBeNull();
    play(rules, ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]); // A 4
    play(rules, SAFE, [fact('b1', { ownHit: true, highestPost: 1 })]); // B 2 → differs
    expect(rules.view().phase).toBe('GAME_OVER');
    expect(rules.view().winner).toBe('A');
  });

  it('rejects transitions after GAME_OVER except rematch', () => {
    const rules = toTiebreak();
    play(rules, ROUNDER, [fact('a1', { ownHit: true, home: true, highestPost: 4 })]);
    play(rules, SAFE, [fact('b1', { ownHit: true, highestPost: 1 })]);
    expect(rules.view().phase).toBe('GAME_OVER');
    expect(rules.readyForPlay()).toBe(false);
    expect(rules.resolvePlay(SAFE, [])).toBeNull();
    expect(rules.bothConnected()).toBe(false);
    expect(rules.rematch()).toBe(true);
    expect(rules.view().phase).toBe('INITIAL_POSITIONING');
    expect(rules.view().tiebreak).toBe(false);
  });
});

describe('completeDraft with drafted squads (M7)', () => {
  it('replaces the constructor squads so batting order = pick order', () => {
    const rules = createRulesModule({ squadA: squad('a1', 'a2'), squadB: squad('b1', 'b2') });
    rules.bothConnected();
    const squadA = squad('laurie', 'carl', 'joel');
    const squadB = squad('ricy', 'kian', 'josh');
    expect(rules.completeDraft({ squadA, squadB })).toBe(true);
    rules.confirmPositioning();
    rules.readyForPlay();
    expect(rules.view().currentBatterId).toBe('laurie'); // A's FIRST PICK bats first, not the table order
  });

  it('does not replace squads when the transition is refused (wrong phase)', () => {
    const rules = createRulesModule({ squadA: squad('a1', 'a2'), squadB: squad('b1', 'b2') });
    const squadA = squad('carl');
    const squadB = squad('joel');
    expect(rules.completeDraft({ squadA, squadB })).toBe(false); // still LOBBY
    rules.bothConnected();
    rules.completeDraft();
    rules.confirmPositioning();
    rules.readyForPlay();
    expect(rules.view().currentBatterId).toBe('a1'); // constructor order intact
  });
});
