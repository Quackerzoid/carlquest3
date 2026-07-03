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

  it('purely-vertical aim (zero horizontal component) is degenerate and falls back to default aim', () => {
    const up = resolveSwing(carl.stats, { aim: { x: 0, y: 5, z: 0 }, spinInput: 0 }, 0);
    const down = resolveSwing(carl.stats, { aim: { x: 0, y: -5, z: 0 }, spinInput: 0 }, 0);
    expect(up.contact).toBe(true);
    expect(down.contact).toBe(true);
    if (up.contact && down.contact) {
      expect(Number.isFinite(up.params.velocity.x)).toBe(true);
      expect(Number.isFinite(up.params.velocity.y)).toBe(true);
      expect(Number.isFinite(up.params.velocity.z)).toBe(true);
      expect(Number.isFinite(down.params.velocity.x)).toBe(true);
      expect(Number.isFinite(down.params.velocity.y)).toBe(true);
      expect(Number.isFinite(down.params.velocity.z)).toBe(true);
      expect(len(up.params.velocity)).toBeCloseTo(34, 8);
      expect(len(down.params.velocity)).toBeCloseTo(34, 8);
      // Same fallback as the zero-vector default aim case.
      const fallback = resolveSwing(carl.stats, { aim: { x: 0, y: 0, z: 0 }, spinInput: 0 }, 0);
      expect(fallback.contact).toBe(true);
      if (fallback.contact) {
        expect(up.params.velocity).toEqual(fallback.params.velocity);
        expect(down.params.velocity).toEqual(fallback.params.velocity);
      }
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
