/**
 * Pure ability registry (spec §3, §9.9). Maps each Character's AbilityId to
 * the mods/params the relevant module (Pitch/Hit/Fielding) applies. Every
 * ability not recognised by a given function returns the neutral default —
 * WALL is deliberately absent from all three (it's a physics/room concern,
 * handled directly by MatchRoom + PhysicsModule's blocker capsule).
 */
import { CONST } from './constants';
import type { Character } from './types';

const A = CONST.ABILITY;

/** FieldingModule ability params — extends the M4 neutral AbilityParams shape. */
export interface FieldingAbilityParams {
  /** Static multiplier (neutral 1). */
  radiusMult: number;
  /** Applied ONLY while the fielder's speed < ABILITY.STATIONARY_SPEED_EPS (LONG_REACH 1.4; neutral 1). */
  stationaryRadiusMult: number;
  /** Additive metres (POWERHOUSE 0.5; neutral 0). */
  radiusBonusM: number;
  /** IMMOVABLE: skip the pCatch roll. */
  guaranteed: boolean;
  /** BUTTERFINGERS 0.35; neutral 0 — no fumble roll is made when 0. */
  fumbleChance: number;
  /** QUICK_DRAW 0.5; neutral 1. */
  releaseDelayMult: number;
  /** POWERHOUSE 2: fatigueMult forced to 1 while stamina >= floor; neutral Infinity (normal fatigue always). */
  fatigueFloor: number;
}

export interface PitchAbilityMods {
  /** CANNON_ARM 3; neutral 0 (uncapped). */
  pitchStatBonus: number;
  /** CURVEBALL_MASTER 1.6; neutral 1. */
  spinCurveMult: number;
  /** CURVEBALL_MASTER 0.6; neutral 0 (curve immediately). */
  curveOnsetFraction: number;
  /** CANNON_ARM 0.85; neutral 1. */
  batterTimingWindowMult: number;
}

export interface HitAbilityMods {
  /** CLUTCH_SWING 3 (final innings only — caller gates); neutral 0. */
  clutchPowerBonus: number;
  /** POWER_BASE 2; neutral 0. */
  powerBaseBonus: number;
  /** POWER_BASE 0.1 s; neutral 0. */
  powerBaseMaxError: number;
  /** SWITCH. */
  spinReadImmune: boolean;
}

const NEUTRAL_FIELDING: FieldingAbilityParams = {
  radiusMult: 1,
  stationaryRadiusMult: 1,
  radiusBonusM: 0,
  guaranteed: false,
  fumbleChance: 0,
  releaseDelayMult: 1,
  fatigueFloor: Infinity,
};

const NEUTRAL_PITCH: PitchAbilityMods = {
  pitchStatBonus: 0,
  spinCurveMult: 1,
  curveOnsetFraction: 0,
  batterTimingWindowMult: 1,
};

const NEUTRAL_HIT: HitAbilityMods = {
  clutchPowerBonus: 0,
  powerBaseBonus: 0,
  powerBaseMaxError: 0,
  spinReadImmune: false,
};

export function fieldingAbilityParams(c: Character): FieldingAbilityParams {
  switch (c.ability) {
    case 'LONG_REACH':
      return { ...NEUTRAL_FIELDING, stationaryRadiusMult: A.LONG_REACH_RADIUS_MULT };
    case 'QUICK_DRAW':
      return { ...NEUTRAL_FIELDING, releaseDelayMult: A.QUICK_DRAW_DELAY_MULT };
    case 'IMMOVABLE':
      return { ...NEUTRAL_FIELDING, guaranteed: true };
    case 'BUTTERFINGERS':
      return { ...NEUTRAL_FIELDING, fumbleChance: A.BUTTERFINGERS_FUMBLE_P };
    case 'POWERHOUSE':
      return {
        ...NEUTRAL_FIELDING,
        radiusBonusM: A.POWERHOUSE_RADIUS_BONUS_M,
        fatigueFloor: A.POWERHOUSE_FATIGUE_FLOOR,
      };
    default:
      return { ...NEUTRAL_FIELDING };
  }
}

export function pitchAbilityMods(c: Character): PitchAbilityMods {
  switch (c.ability) {
    case 'CANNON_ARM':
      return {
        ...NEUTRAL_PITCH,
        pitchStatBonus: A.CANNON_PITCH_BONUS,
        batterTimingWindowMult: A.CANNON_TIMING_WINDOW_MULT,
      };
    case 'CURVEBALL_MASTER':
      return {
        ...NEUTRAL_PITCH,
        spinCurveMult: A.CURVE_SPIN_MULT,
        curveOnsetFraction: A.CURVE_ONSET_FRACTION,
      };
    default:
      return { ...NEUTRAL_PITCH };
  }
}

export function hitAbilityMods(c: Character): HitAbilityMods {
  switch (c.ability) {
    case 'CLUTCH_SWING':
      return { ...NEUTRAL_HIT, clutchPowerBonus: A.CLUTCH_POWER_BONUS };
    case 'POWER_BASE':
      return {
        ...NEUTRAL_HIT,
        powerBaseBonus: A.POWER_BASE_BONUS,
        powerBaseMaxError: A.POWER_BASE_MAX_ERROR,
      };
    case 'SWITCH':
      return { ...NEUTRAL_HIT, spinReadImmune: true };
    default:
      return { ...NEUTRAL_HIT };
  }
}
