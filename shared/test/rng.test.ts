import { describe, expect, it } from 'vitest';
import { createRng } from '../src/index';

describe('createRng (mulberry32, deterministic — M4)', () => {
  it('yields an identical first-10 sequence from two instances with the same seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('yields differing sequences from different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('keeps 1000 consecutive outputs in [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('pins the seed-42 first output exactly (guards against algorithm drift)', () => {
    // Computed once from this mulberry32 implementation; a change here means the
    // PRNG algorithm changed, which would silently desync seeded catch rolls.
    expect(createRng(42)()).toBe(0.6011037519201636);
  });
});
