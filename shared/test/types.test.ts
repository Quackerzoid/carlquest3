import { describe, expect, it } from 'vitest';
import type { PlayOutcome, PlayResolution, SettlementFact, TeamSide } from '../src/types';

describe('M5 shared contracts (types)', () => {
  it('TeamSide accepts only A or B', () => {
    const a: TeamSide = 'A';
    const b: TeamSide = 'B';
    expect([a, b]).toEqual(['A', 'B']);
  });

  it('PlayResolution shape compiles and round-trips JSON', () => {
    const resolution: PlayResolution = {
      cause: { kind: 'runOut', atPost: 2, runnerId: 'carl' },
      outs: ['carl'],
      scoreDeltaHalves: 1,
      batterId: 'carl',
    };
    const roundTripped = JSON.parse(JSON.stringify(resolution)) as PlayResolution;
    expect(roundTripped).toEqual(resolution);
  });

  it('SettlementFact shape compiles and round-trips JSON', () => {
    const fact: SettlementFact = {
      runnerId: 'kian',
      ownHit: true,
      highestPost: 3,
      home: false,
      out: false,
    };
    const roundTripped = JSON.parse(JSON.stringify(fact)) as SettlementFact;
    expect(roundTripped).toEqual(fact);
  });

  it('runOut requires runnerId (type-level)', () => {
    // @ts-expect-error runnerId is required on the runOut member
    const missing: PlayOutcome = { kind: 'runOut', atPost: 1 };
    expect(missing).toBeDefined();
  });

  it('safe requires runnerId (type-level)', () => {
    // @ts-expect-error runnerId is required on the safe member
    const missing: PlayOutcome = { kind: 'safe', atPost: 0 };
    expect(missing).toBeDefined();
  });
});
