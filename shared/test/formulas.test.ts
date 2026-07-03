import { describe, expect, it } from 'vitest';
import {
  CONST,
  approachPenalty,
  catchRadius,
  clamp01,
  exitVelocity,
  fatigueMult,
  hitSpin,
  moveSpeed,
  pCatch,
  pitchSpeed,
  pitchSpin,
  pressureMult,
  s01,
  timingFactor,
  timingWindow,
} from '../src/index';

const G = CONST.GAME;

describe('formulas (spec §5, exact shapes)', () => {
  it('s01 normalises stats to 0..1', () => {
    expect(s01(1)).toBe(0.1);
    expect(s01(5)).toBe(0.5);
    expect(s01(10)).toBe(1);
  });

  it('clamp01 clamps', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);
  });

  it('moveSpeed spans MOVE_MIN..MOVE_MAX and scales by fatigue', () => {
    expect(moveSpeed(10, 1)).toBeCloseTo(G.MOVE_MAX, 10);
    expect(moveSpeed(5, 1)).toBeCloseTo(G.MOVE_MIN + (G.MOVE_MAX - G.MOVE_MIN) * 0.5, 10);
    expect(moveSpeed(10, 0.5)).toBeCloseTo(G.MOVE_MIN + (G.MOVE_MAX - G.MOVE_MIN) * 1 * 0.5, 10);
  });

  it('catchRadius spans REACH_MIN..REACH_MAX', () => {
    expect(catchRadius(1)).toBeCloseTo(G.REACH_MIN + (G.REACH_MAX - G.REACH_MIN) * 0.1, 10);
    expect(catchRadius(10)).toBeCloseTo(G.REACH_MAX, 10);
  });

  it('pitchSpeed spans PITCH_MIN..PITCH_MAX (Kian pitch 8 = 26.4 m/s)', () => {
    expect(pitchSpeed(8)).toBeCloseTo(26.4, 10);
    expect(pitchSpeed(1)).toBeCloseTo(G.PITCH_MIN + (G.PITCH_MAX - G.PITCH_MIN) * 0.1, 10);
  });

  it('pitchSpin scales SPIN_MAX_RADS by s01 and curveMult', () => {
    expect(pitchSpin(9, 1)).toBeCloseTo(G.SPIN_MAX_RADS * 0.9, 10);
    expect(pitchSpin(9, 1.6)).toBeCloseTo(G.SPIN_MAX_RADS * 0.9 * 1.6, 10);
    expect(pitchSpin(0, 1)).toBe(0);
  });

  it('timingWindow = BASE * (0.6 + 0.4·s01(reflex)), optional windowMult', () => {
    expect(timingWindow(10)).toBeCloseTo(G.BASE_TIMING_WINDOW * 1.0, 10);
    expect(timingWindow(5)).toBeCloseTo(G.BASE_TIMING_WINDOW * 0.8, 10);
    expect(timingWindow(10, 0.85)).toBeCloseTo(G.BASE_TIMING_WINDOW * 0.85, 10);
  });

  it('timingFactor = clamp(1 - |err|/window, 0, 1)', () => {
    const w = 0.2;
    expect(timingFactor(0, w)).toBe(1);
    expect(timingFactor(0.1, w)).toBeCloseTo(0.5, 10);
    expect(timingFactor(-0.1, w)).toBeCloseTo(0.5, 10);
    expect(timingFactor(0.2, w)).toBe(0);
    expect(timingFactor(0.5, w)).toBe(0);
  });

  it('exitVelocity spans HIT_MIN..HIT_MAX scaled by timing (Carl power 8, perfect = 34 m/s)', () => {
    expect(exitVelocity(8, 1)).toBeCloseTo(34, 10);
    expect(exitVelocity(8, 0.5)).toBeCloseTo(17, 10);
    expect(exitVelocity(8, 0)).toBe(0);
  });

  it('hitSpin mirrors pitchSpin with hitCurveMult', () => {
    expect(hitSpin(5, 1)).toBeCloseTo(G.SPIN_MAX_RADS * 0.5, 10);
    expect(hitSpin(5, 2)).toBeCloseTo(G.SPIN_MAX_RADS, 10);
  });

  it('pCatch = clamp(BASE + Iw·s01(ins) + Rw·s01(rfx) - penalty, 0, 1)', () => {
    expect(pCatch(10, 10, 0)).toBeCloseTo(G.BASE_CATCH + G.INSTINCT_W + G.REFLEX_W, 10);
    expect(pCatch(5, 5, 0)).toBeCloseTo(G.BASE_CATCH + G.INSTINCT_W * 0.5 + G.REFLEX_W * 0.5, 10);
    expect(pCatch(1, 1, 1)).toBe(0); // clamped at 0
    expect(pCatch(10, 10, -1)).toBe(1); // clamped at 1
  });

  it('fatigueMult is 1 at stamina >= 3, else 0.6 + 0.4·(stamina/3)', () => {
    expect(fatigueMult(10)).toBe(1);
    expect(fatigueMult(3)).toBe(1);
    expect(fatigueMult(2.999)).toBeCloseTo(0.6 + 0.4 * (2.999 / 3), 10);
    expect(fatigueMult(0)).toBeCloseTo(0.6, 10);
  });

  it('pressureMult = 0.85 + 0.15·s01(nerve)', () => {
    expect(pressureMult(10)).toBeCloseTo(1, 10);
    expect(pressureMult(0)).toBeCloseTo(0.85, 10);
    expect(pressureMult(8)).toBeCloseTo(0.97, 10);
  });

  it('approachPenalty = APPROACH_W · clamp01(speed / APPROACH_REF_SPEED)', () => {
    expect(approachPenalty(0)).toBe(0);
    expect(approachPenalty(15)).toBe(0.175);
    expect(approachPenalty(30)).toBe(0.35);
    expect(approachPenalty(60)).toBe(0.35); // clamped at the reference speed
    expect(approachPenalty(-5)).toBe(0); // negative speeds clamp to 0
  });

  it('formulas are pure (repeat calls identical)', () => {
    expect(pitchSpeed(7)).toBe(pitchSpeed(7));
    expect(pCatch(6, 7, 0.2)).toBe(pCatch(6, 7, 0.2));
  });
});
