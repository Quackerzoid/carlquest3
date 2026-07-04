/**
 * Stat → gameplay formulas (spec §5). Pure functions only — no state, no I/O.
 * Every tunable comes from CONST.GAME. Stats are 1-10 integers from the roster;
 * these functions are total for any finite input and do not validate range.
 */
import { CONST } from './constants';

const G = CONST.GAME;

/** Normalise a 1-10 stat to 0..1 (spec §5: s01 = stat / 10). */
export function s01(stat: number): number {
  return stat / 10;
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Movement speed in m/s; fatigue comes from fatigueMult(stamina). */
export function moveSpeed(speed: number, fatigue: number): number {
  return G.MOVE_MIN + (G.MOVE_MAX - G.MOVE_MIN) * s01(speed) * fatigue;
}

/** Catch radius in metres (ability multipliers applied by FieldingModule, M4+). */
export function catchRadius(reach: number): number {
  return G.REACH_MIN + (G.REACH_MAX - G.REACH_MIN) * s01(reach);
}

/** Pitch initial speed in m/s. */
export function pitchSpeed(pitch: number): number {
  return G.PITCH_MIN + (G.PITCH_MAX - G.PITCH_MIN) * s01(pitch);
}

/** Pitch spin in rad/s; curveMult is 1 until CURVEBALL_MASTER (M9). */
export function pitchSpin(spin: number, curveMult: number): number {
  return G.SPIN_MAX_RADS * s01(spin) * curveMult;
}

/** Batter timing window in seconds; windowMult is 1 until CANNON_ARM (M9). */
export function timingWindow(reflex: number, windowMult = 1): number {
  return G.BASE_TIMING_WINDOW * (0.6 + 0.4 * s01(reflex)) * windowMult;
}

/** 1 at perfect timing, linearly down to 0 at the window edge. */
export function timingFactor(timingError: number, window: number): number {
  return clamp01(1 - Math.abs(timingError) / window);
}

/** Hit exit velocity in m/s. */
export function exitVelocity(power: number, timing: number): number {
  return (G.HIT_MIN + (G.HIT_MAX - G.HIT_MIN) * s01(power)) * timing;
}

/** Hit launch spin in rad/s; hitCurveMult is 1 until abilities (M9). */
export function hitSpin(spin: number, hitCurveMult: number): number {
  return G.SPIN_MAX_RADS * s01(spin) * hitCurveMult;
}

/** pCatch approach penalty: faster incoming balls are harder to catch (spec §5 names the term; M4 defines it). */
export function approachPenalty(ballSpeed: number): number {
  return G.APPROACH_W * clamp01(ballSpeed / G.APPROACH_REF_SPEED);
}

/** Catch success probability before ability overrides (spec §5). */
export function pCatch(instinct: number, reflex: number, approachPenalty: number): number {
  return clamp01(G.BASE_CATCH + G.INSTINCT_W * s01(instinct) + G.REFLEX_W * s01(reflex) - approachPenalty);
}

/** Full effectiveness at stamina >= 3, degrading to 0.6 at zero stamina. */
export function fatigueMult(stamina: number): number {
  return stamina >= 3 ? 1 : 0.6 + 0.4 * (stamina / 3);
}

/** Applied to timingFactor and pCatch in high-pressure states (spec §5). */
export function pressureMult(nerve: number): number {
  return 0.85 + 0.15 * s01(nerve);
}

/**
 * Timing-window multiplier applied against spin (M9 design doc §1): a
 * USER-APPROVED invented formula giving SWITCH a real counterpart mechanic —
 * every batter's timing window shrinks against a spinning pitch unless
 * immune. `1 − SPIN_READ_W · s01(spinStat) · |spinInput|`, clamped to >= 0.
 */
export function spinReadPenalty(spinStat: number, spinInput: number): number {
  return Math.max(0, 1 - CONST.ABILITY.SPIN_READ_W * s01(spinStat) * Math.abs(spinInput));
}
