import { describe, expect, it } from 'vitest';
import { CONST, getCharacter, pitchAbilityMods, pitchSpeed, pitchSpin } from '@carlquest/shared';
import { resolvePitch } from '../src/modules/PitchModule';

const kian = getCharacter('kian');
const joel = getCharacter('joel');
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

  it('purely-vertical aim (zero horizontal component) is degenerate and falls back to default aim', () => {
    for (const aim of [{ x: 0, y: 5, z: 0 }, { x: 0, y: -5, z: 0 }]) {
      const p = resolvePitch(kian.stats, { aim, spinInput: 0 });
      expect(Number.isFinite(p.velocity.x)).toBe(true);
      expect(Number.isFinite(p.velocity.y)).toBe(true);
      expect(Number.isFinite(p.velocity.z)).toBe(true);
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

  describe('ability mods (Milestone 9)', () => {
    it('neutral/absent mods produce identical params to today\'s output (no curveOnsetS)', () => {
      const input = { aim: { x: 0, y: 0, z: -1 }, spinInput: 1 };
      const withoutMods = resolvePitch(kian.stats, input);
      const withNeutral = resolvePitch(kian.stats, input, {
        pitchStatBonus: 0,
        spinCurveMult: 1,
        curveOnsetFraction: 0,
        batterTimingWindowMult: 1,
      });
      expect(withNeutral).toEqual(withoutMods);
      expect(withoutMods.curveOnsetS === undefined || withoutMods.curveOnsetS === 0).toBe(true);
    });

    it("CURVEBALL_MASTER: spin scaled by spinCurveMult (x1.6) and curveOnsetS computed from flight-to-plane time", () => {
      const input = { aim: { x: 0, y: 0, z: -1 }, spinInput: 1 };
      const mods = pitchAbilityMods(kian); // kian's ability is CURVEBALL_MASTER
      const neutral = resolvePitch(kian.stats, input);
      const curved = resolvePitch(kian.stats, input, mods);

      expect(curved.angularVelocity.y).toBeCloseTo(neutral.angularVelocity.y * mods.spinCurveMult, 8);

      const speed = pitchSpeed(kian.stats.pitch);
      // Aim is straight -z, same axis as BOWLING_SQUARE -> BATTING_SQUARE.
      const distance = Math.abs(CONST.FIELD.BOWLING_SQUARE.z - CONST.FIELD.BATTING_SQUARE.z);
      const expectedOnset = (distance / speed) * mods.curveOnsetFraction;

      expect(curved.curveOnsetS).toBeGreaterThan(0);
      expect(curved.curveOnsetS).toBeCloseTo(expectedOnset, 8);
    });

    it('CANNON_ARM: velocity magnitude uses stats.pitch + pitchStatBonus, uncapped', () => {
      const input = { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 };
      const mods = pitchAbilityMods(joel); // joel's ability is CANNON_ARM
      const boosted = resolvePitch(joel.stats, input, mods);
      expect(len(boosted.velocity)).toBeCloseTo(pitchSpeed(joel.stats.pitch + mods.pitchStatBonus), 8);
    });
  });
});
