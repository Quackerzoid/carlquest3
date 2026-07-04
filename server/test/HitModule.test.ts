import { describe, expect, it } from 'vitest';
import {
  CONST,
  exitVelocity,
  getCharacter,
  hitAbilityMods,
  pressureMult,
  spinReadPenalty,
  timingWindow,
  type HitAbilityMods,
} from '@carlquest/shared';
import { NEUTRAL_SWING_CONTEXT, resolveSwing } from '../src/modules/HitModule';

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

  it('ctx.timingWindowMult shrinks the window (CANNON_ARM hook, default 1)', () => {
    const w = timingWindow(carl.stats.reflex);
    const errJustInside = w * 0.9;
    expect(resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errJustInside).contact).toBe(true);
    expect(
      resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errJustInside, {
        ...NEUTRAL_SWING_CONTEXT,
        timingWindowMult: 0.85,
      }).contact,
    ).toBe(false);
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

  it('a NaN timing factor (zero window from timingWindowMult 0) resolves as a miss, not NaN velocities', () => {
    const r = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0, {
      ...NEUTRAL_SWING_CONTEXT,
      timingWindowMult: 0,
    });
    expect(r.contact).toBe(false);
  });

  it('is pure — repeat calls identical, input unmutated', () => {
    const input = { aim: { x: 1, y: 0.5, z: 1 }, spinInput: 0.3 };
    expect(resolveSwing(carl.stats, input, 0.02)).toEqual(resolveSwing(carl.stats, input, 0.02));
    expect(input.aim).toEqual({ x: 1, y: 0.5, z: 1 });
  });

  describe('pressure (M5)', () => {
    it('ctx.pressure=true scales exit velocity by exactly pressureMult(nerve) — Carl nerve 8', () => {
      const withoutPressure = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0);
      const withPressure = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0, {
        ...NEUTRAL_SWING_CONTEXT,
        pressure: true,
      });
      expect(withoutPressure.contact).toBe(true);
      expect(withPressure.contact).toBe(true);
      if (withoutPressure.contact && withPressure.contact) {
        const factor = pressureMult(carl.stats.nerve);
        expect(len(withPressure.params.velocity)).toBeCloseTo(
          len(withoutPressure.params.velocity) * factor,
          8,
        );
        expect(withPressure.timingFactor).toBeCloseTo(withoutPressure.timingFactor * factor, 8);
      }
    });

    it('ctx.pressure=true scales exit velocity by exactly pressureMult(nerve) — Joe nerve 2', () => {
      const joe = getCharacter('joe');
      const withoutPressure = resolveSwing(joe.stats, { aim: FLAT_AIM, spinInput: 0 }, 0);
      const withPressure = resolveSwing(joe.stats, { aim: FLAT_AIM, spinInput: 0 }, 0, {
        ...NEUTRAL_SWING_CONTEXT,
        pressure: true,
      });
      expect(withoutPressure.contact).toBe(true);
      expect(withPressure.contact).toBe(true);
      if (withoutPressure.contact && withPressure.contact) {
        const factor = pressureMult(joe.stats.nerve);
        expect(len(withPressure.params.velocity)).toBeCloseTo(
          len(withoutPressure.params.velocity) * factor,
          8,
        );
        expect(withPressure.timingFactor).toBeCloseTo(withoutPressure.timingFactor * factor, 8);
      }
    });

    it('ctx.pressure defaults to false — omitting ctx is byte-identical to NEUTRAL_SWING_CONTEXT', () => {
      const omitted = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0);
      const explicit = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0, NEUTRAL_SWING_CONTEXT);
      expect(omitted).toEqual(explicit);
    });
  });

  describe('SwingContext / abilities (M9)', () => {
    it('CANNON_ARM (ctx.timingWindowMult 0.85) shrinks the window: an error between the neutral and shrunk windows connects at neutral but misses under CANNON', () => {
      const neutralWindow = timingWindow(carl.stats.reflex, NEUTRAL_SWING_CONTEXT.timingWindowMult);
      const cannonMult = CONST.ABILITY.CANNON_TIMING_WINDOW_MULT;
      const cannonWindow = timingWindow(carl.stats.reflex, cannonMult);
      const errBetween = (neutralWindow + cannonWindow) / 2;

      const neutral = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errBetween);
      const underCannon = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errBetween, {
        ...NEUTRAL_SWING_CONTEXT,
        timingWindowMult: cannonMult,
      });
      expect(neutral.contact).toBe(true);
      expect(underCannon.contact).toBe(false);
    });

    it('spin-read penalty shrinks the window against a spinning pitch unless SWITCH-immune', () => {
      const pitcherSpinStat = 10;
      const pitchSpinInput = 1;
      const penalty = spinReadPenalty(pitcherSpinStat, pitchSpinInput);
      expect(penalty).toBeLessThan(1);

      const neutralWindow = timingWindow(carl.stats.reflex);
      const penalisedWindow = neutralWindow * penalty;
      // An error strictly between the penalised and full window: the penalised
      // (non-immune) batter misses, but a SWITCH-immune batter still connects.
      const errBetween = (penalisedWindow + neutralWindow) / 2;

      const nonImmuneMods: HitAbilityMods = hitAbilityMods(carl); // CLUTCH_SWING, not immune
      const nonImmune = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, errBetween, {
        ...NEUTRAL_SWING_CONTEXT,
        mods: nonImmuneMods,
        pitcherSpinStat,
        pitchSpinInput,
      });
      expect(nonImmune.contact).toBe(false);

      const darcy = getCharacter('darcy'); // SWITCH
      const immuneMods = hitAbilityMods(darcy);
      expect(immuneMods.spinReadImmune).toBe(true);
      const immune = resolveSwing(darcy.stats, { aim: FLAT_AIM, spinInput: 0 }, errBetween, {
        ...NEUTRAL_SWING_CONTEXT,
        mods: immuneMods,
        pitcherSpinStat,
        pitchSpinInput,
      });
      expect(immune.contact).toBe(true);
    });

    it('CLUTCH_SWING adds clutchPowerBonus to exit velocity ONLY when ctx.isFinalInnings is true', () => {
      const carlMods = hitAbilityMods(carl); // CLUTCH_SWING
      const base = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0, {
        ...NEUTRAL_SWING_CONTEXT,
        mods: carlMods,
        isFinalInnings: false,
      });
      const clutch = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, 0, {
        ...NEUTRAL_SWING_CONTEXT,
        mods: carlMods,
        isFinalInnings: true,
      });
      expect(base.contact).toBe(true);
      expect(clutch.contact).toBe(true);
      if (base.contact && clutch.contact) {
        expect(len(base.params.velocity)).toBeCloseTo(exitVelocity(carl.stats.power, 1), 8);
        expect(len(clutch.params.velocity)).toBeCloseTo(
          exitVelocity(carl.stats.power + carlMods.clutchPowerBonus, 1),
          8,
        );
      }
    });

    it('POWER_BASE adds powerBaseBonus to exit velocity only when |timingError| < powerBaseMaxError', () => {
      const robbie = getCharacter('robbie'); // POWER_BASE
      const mods = hitAbilityMods(robbie);
      expect(mods.powerBaseMaxError).toBe(CONST.ABILITY.POWER_BASE_MAX_ERROR);

      const smallError = 0.05; // < 0.1: bonus applies
      const largeError = 0.15; // >= 0.1: no bonus

      const withBonus = resolveSwing(robbie.stats, { aim: FLAT_AIM, spinInput: 0 }, smallError, {
        ...NEUTRAL_SWING_CONTEXT,
        mods,
      });
      const withoutBonus = resolveSwing(robbie.stats, { aim: FLAT_AIM, spinInput: 0 }, largeError, {
        ...NEUTRAL_SWING_CONTEXT,
        mods,
      });
      expect(withBonus.contact).toBe(true);
      expect(withoutBonus.contact).toBe(true);
      if (withBonus.contact && withoutBonus.contact) {
        const window = timingWindow(robbie.stats.reflex);
        const timingSmall = 1 - Math.abs(smallError) / window;
        const timingLarge = 1 - Math.abs(largeError) / window;
        expect(len(withBonus.params.velocity)).toBeCloseTo(
          exitVelocity(robbie.stats.power + mods.powerBaseBonus, timingSmall),
          8,
        );
        expect(len(withoutBonus.params.velocity)).toBeCloseTo(
          exitVelocity(robbie.stats.power, timingLarge),
          8,
        );
      }
    });

    it('CLUTCH_SWING and POWER_BASE compose additively (synthetic mods — no single character has both)', () => {
      const syntheticMods: HitAbilityMods = {
        clutchPowerBonus: CONST.ABILITY.CLUTCH_POWER_BONUS,
        powerBaseBonus: CONST.ABILITY.POWER_BASE_BONUS,
        powerBaseMaxError: CONST.ABILITY.POWER_BASE_MAX_ERROR,
        spinReadImmune: false,
      };
      const smallError = 0.05;
      const result = resolveSwing(carl.stats, { aim: FLAT_AIM, spinInput: 0 }, smallError, {
        ...NEUTRAL_SWING_CONTEXT,
        mods: syntheticMods,
        isFinalInnings: true,
      });
      expect(result.contact).toBe(true);
      if (result.contact) {
        const window = timingWindow(carl.stats.reflex);
        const timing = 1 - Math.abs(smallError) / window;
        const expectedPower =
          carl.stats.power + syntheticMods.clutchPowerBonus + syntheticMods.powerBaseBonus;
        expect(len(result.params.velocity)).toBeCloseTo(exitVelocity(expectedPower, timing), 8);
      }
    });
  });
});
