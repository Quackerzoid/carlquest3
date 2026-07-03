/**
 * Deterministic seedable PRNG (mulberry32) — exists so server-side catch rolls
 * (M4 FieldingModule) and tests draw reproducible randomness from an injected
 * seed; Math.random is banned in /server and /shared.
 */

/** Returns a generator yielding floats in [0, 1); same seed ⇒ same sequence. */
export function createRng(seed: number): () => number {
  // mulberry32 (public domain). The hex/shift constants below ARE the
  // algorithm, not gameplay tunables — they do not belong in CONST.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 2^32
  };
}
