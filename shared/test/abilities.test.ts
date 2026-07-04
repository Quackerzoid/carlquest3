import { describe, expect, it } from 'vitest';
import { CHARACTERS, getCharacter, fieldingAbilityParams, hitAbilityMods, pitchAbilityMods } from '../src/index';

const NEUTRAL_FIELDING = {
  radiusMult: 1,
  stationaryRadiusMult: 1,
  radiusBonusM: 0,
  guaranteed: false,
  fumbleChance: 0,
  releaseDelayMult: 1,
  fatigueFloor: Infinity,
};

const NEUTRAL_PITCH = {
  pitchStatBonus: 0,
  spinCurveMult: 1,
  curveOnsetFraction: 0,
  batterTimingWindowMult: 1,
};

const NEUTRAL_HIT = {
  clutchPowerBonus: 0,
  powerBaseBonus: 0,
  powerBaseMaxError: 0,
  spinReadImmune: false,
};

describe('ability registry (spec §3, §9.9) — exact mapping per roster character', () => {
  it('kian (CURVEBALL_MASTER) gets the curve pitch mods', () => {
    expect(pitchAbilityMods(getCharacter('kian'))).toEqual({
      pitchStatBonus: 0,
      spinCurveMult: 1.6,
      curveOnsetFraction: 0.6,
      batterTimingWindowMult: 1,
    });
  });

  it('joel (CANNON_ARM) gets the cannon pitch mods', () => {
    expect(pitchAbilityMods(getCharacter('joel'))).toEqual({
      pitchStatBonus: 3,
      spinCurveMult: 1,
      curveOnsetFraction: 0,
      batterTimingWindowMult: 0.85,
    });
  });

  it('carl (CLUTCH_SWING) gets the clutch hit mods', () => {
    expect(hitAbilityMods(getCharacter('carl'))).toEqual({
      clutchPowerBonus: 3,
      powerBaseBonus: 0,
      powerBaseMaxError: 0,
      spinReadImmune: false,
    });
  });

  it('robbie (POWER_BASE) gets the power-base hit mods', () => {
    expect(hitAbilityMods(getCharacter('robbie'))).toEqual({
      clutchPowerBonus: 0,
      powerBaseBonus: 2,
      powerBaseMaxError: 0.1,
      spinReadImmune: false,
    });
  });

  it('darcy (SWITCH) is spin-read immune', () => {
    expect(hitAbilityMods(getCharacter('darcy')).spinReadImmune).toBe(true);
  });

  it('laurie (LONG_REACH) gets stationaryRadiusMult 1.4', () => {
    expect(fieldingAbilityParams(getCharacter('laurie')).stationaryRadiusMult).toBe(1.4);
  });

  it('josh (QUICK_DRAW) gets releaseDelayMult 0.5', () => {
    expect(fieldingAbilityParams(getCharacter('josh')).releaseDelayMult).toBe(0.5);
  });

  it('jonty (IMMOVABLE) gets guaranteed true', () => {
    expect(fieldingAbilityParams(getCharacter('jonty')).guaranteed).toBe(true);
  });

  it('joe (BUTTERFINGERS) gets fumbleChance 0.35', () => {
    expect(fieldingAbilityParams(getCharacter('joe')).fumbleChance).toBe(0.35);
  });

  it('ricy (POWERHOUSE) gets radiusBonusM 0.5 and fatigueFloor 2', () => {
    const params = fieldingAbilityParams(getCharacter('ricy'));
    expect(params.radiusBonusM).toBe(0.5);
    expect(params.fatigueFloor).toBe(2);
  });

  it('whale (WALL) is neutral in all three registry functions (WALL is physics/room, not registry)', () => {
    const whale = getCharacter('whale');
    expect(fieldingAbilityParams(whale)).toEqual(NEUTRAL_FIELDING);
    expect(pitchAbilityMods(whale)).toEqual(NEUTRAL_PITCH);
    expect(hitAbilityMods(whale)).toEqual(NEUTRAL_HIT);
  });

  it('a neutral character (carl) gets the full neutral fielding object', () => {
    expect(fieldingAbilityParams(getCharacter('carl'))).toEqual(NEUTRAL_FIELDING);
  });

  it('a neutral character (kian, CURVEBALL_MASTER) gets the full neutral hit object', () => {
    expect(hitAbilityMods(getCharacter('kian'))).toEqual(NEUTRAL_HIT);
  });

  it('a neutral character (carl, CLUTCH_SWING) gets the full neutral pitch object', () => {
    expect(pitchAbilityMods(getCharacter('carl'))).toEqual(NEUTRAL_PITCH);
  });

  it('every roster character has a defined mapping in all three functions (no throw)', () => {
    for (const c of CHARACTERS) {
      expect(() => fieldingAbilityParams(c)).not.toThrow();
      expect(() => pitchAbilityMods(c)).not.toThrow();
      expect(() => hitAbilityMods(c)).not.toThrow();
    }
  });
});
