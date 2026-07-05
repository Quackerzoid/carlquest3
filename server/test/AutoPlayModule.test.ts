/**
 * AutoPlayModule — pure dice-roll decisions for the auto-play redesign (2026-07-05).
 *
 * DRAW-COUNT CONTRACT (fixed; deterministic replay depends on this order —
 * document any change here alongside the implementation):
 *   - pitchDecision: 3 draws — [0] spin magnitude (stat-weighted), [1] spin sign,
 *     [2] aim scatter (shared by both horizontal axes via a single roll mapped to
 *     an angle offset).
 *   - swingDecision: 2 draws — [0] timingError (uniform in ±AUTOPLAY_TIMING_NOISE_S),
 *     [1] aim zone roll (power-weighted across the legal fan of posts).
 *   - runDecision: 1 draw — the go/stay roll against pGo.
 */
import { describe, expect, it } from 'vitest';
import { CHARACTERS, CONST, createRng, getCharacter, NEUTRAL_PITCH_MODS } from '@carlquest/shared';
import { createAutoPlayModule, type RunSituation } from '../src/modules/AutoPlayModule';

const { GAME, FIELD } = CONST;
const DEG_TO_RAD = Math.PI / 180;

const kian = getCharacter('kian'); // spin 9
const joe = getCharacter('joe'); // spin 2
const carl = getCharacter('carl'); // nerve 8
const joeNerve = getCharacter('joe'); // nerve 2

function elevationDeg(aim: { x: number; y: number; z: number }): number {
  const horizontal = Math.hypot(aim.x, aim.z);
  return Math.atan2(aim.y, horizontal) / DEG_TO_RAD;
}

describe('AutoPlayModule', () => {
  describe('pitchDecision', () => {
    it('is exactly reproducible from the same seed', () => {
      const a = createAutoPlayModule(createRng(42));
      const b = createAutoPlayModule(createRng(42));
      const ra = a.pitchDecision(kian, NEUTRAL_PITCH_MODS);
      const rb = b.pitchDecision(kian, NEUTRAL_PITCH_MODS);
      expect(ra).toEqual(rb);
    });

    it('spin magnitude statistically correlates with the spin stat (>=200 draws, fixed seed)', () => {
      const N = 200;
      const kianModule = createAutoPlayModule(createRng(7));
      const joeModule = createAutoPlayModule(createRng(7));
      let kianStrong = 0;
      let joeStrong = 0;
      for (let i = 0; i < N; i++) {
        if (Math.abs(kianModule.pitchDecision(kian, NEUTRAL_PITCH_MODS).input.spinInput) >= 0.5) kianStrong++;
        if (Math.abs(joeModule.pitchDecision(joe, NEUTRAL_PITCH_MODS).input.spinInput) >= 0.5) joeStrong++;
      }
      expect(kianStrong).toBeGreaterThan(joeStrong);
    });

    it('spinInput is always within [-1, 1] and aim stays within the pitch elevation cap', () => {
      const auto = createAutoPlayModule(createRng(123));
      for (let i = 0; i < 200; i++) {
        const { input } = auto.pitchDecision(kian, NEUTRAL_PITCH_MODS);
        expect(input.spinInput).toBeGreaterThanOrEqual(-1);
        expect(input.spinInput).toBeLessThanOrEqual(1);
        const deg = elevationDeg(input.aim);
        expect(deg).toBeLessThanOrEqual(GAME.PITCH_ELEVATION_MAX_DEG + 1e-6);
        expect(deg).toBeGreaterThanOrEqual(-GAME.PITCH_ELEVATION_MAX_DEG - 1e-6);
      }
    });

    it('aim is finite and roughly towards the batting square (never wildly off-axis)', () => {
      const auto = createAutoPlayModule(createRng(99));
      const { input } = auto.pitchDecision(kian, NEUTRAL_PITCH_MODS);
      expect(Number.isFinite(input.aim.x)).toBe(true);
      expect(Number.isFinite(input.aim.y)).toBe(true);
      expect(Number.isFinite(input.aim.z)).toBe(true);
      // z-component must point from the bowling square towards the batting square.
      const towardsBatter = Math.sign(FIELD.BATTING_SQUARE.z - FIELD.BOWLING_SQUARE.z);
      expect(Math.sign(input.aim.z)).toBe(towardsBatter);
    });

    it('returns a well-formed pitch roll event', () => {
      const auto = createAutoPlayModule(createRng(5));
      const { roll } = auto.pitchDecision(kian, NEUTRAL_PITCH_MODS);
      expect(roll.contest).toBe('pitch');
      expect(roll.actorId).toBe(kian.id);
      expect(roll.roll).toBeGreaterThanOrEqual(0);
      expect(roll.roll).toBeLessThan(1);
      expect(typeof roll.detail).toBe('string');
      expect(roll.detail.length).toBeGreaterThan(0);
      expect(typeof roll.success).toBe('boolean');
    });
  });

  describe('swingDecision', () => {
    it('is exactly reproducible from the same seed', () => {
      const a = createAutoPlayModule(createRng(11));
      const b = createAutoPlayModule(createRng(11));
      const ra = a.swingDecision(carl, GAME.BASE_TIMING_WINDOW);
      const rb = b.swingDecision(carl, GAME.BASE_TIMING_WINDOW);
      expect(ra).toEqual(rb);
    });

    it('timingError always stays within +/- AUTOPLAY_TIMING_NOISE_S', () => {
      const auto = createAutoPlayModule(createRng(3));
      for (let i = 0; i < 200; i++) {
        const { timingError } = auto.swingDecision(carl, GAME.BASE_TIMING_WINDOW);
        expect(Math.abs(timingError)).toBeLessThanOrEqual(GAME.AUTOPLAY_TIMING_NOISE_S);
      }
    });

    it("the roll's threshold equals the passed effectiveWindow (so CANNON/spin-read shrink it)", () => {
      const auto = createAutoPlayModule(createRng(17));
      const wideWindow = 0.25;
      const shrunkWindow = 0.1;
      const wide = auto.swingDecision(carl, wideWindow);
      const shrunk = auto.swingDecision(carl, shrunkWindow);
      expect(wide.roll.threshold).toBe(wideWindow);
      expect(shrunk.roll.threshold).toBe(shrunkWindow);
    });

    it('roll.success matches |timingError| < effectiveWindow', () => {
      const auto = createAutoPlayModule(createRng(21));
      for (let i = 0; i < 100; i++) {
        const window = 0.15;
        const { timingError, roll } = auto.swingDecision(carl, window);
        expect(roll.success).toBe(Math.abs(timingError) < window);
      }
    });

    it('aim vectors always land inside the legal horizontal fan and elevation bounds', () => {
      const auto = createAutoPlayModule(createRng(31));
      for (let i = 0; i < 200; i++) {
        const { input } = auto.swingDecision(carl, GAME.BASE_TIMING_WINDOW);
        expect(Number.isFinite(input.aim.x)).toBe(true);
        expect(Number.isFinite(input.aim.y)).toBe(true);
        expect(Number.isFinite(input.aim.z)).toBe(true);
        const deg = elevationDeg(input.aim);
        expect(deg).toBeLessThanOrEqual(GAME.HIT_ELEVATION_MAX_DEG + 1e-6);
        expect(deg).toBeGreaterThanOrEqual(GAME.HIT_ELEVATION_MIN_DEG - 1e-6);
        expect(input.spinInput).toBeGreaterThanOrEqual(-1);
        expect(input.spinInput).toBeLessThanOrEqual(1);
      }
    });

    it('high power biases towards deeper/wider zones than low power (statistical, fixed seed)', () => {
      const N = 200;
      const powerful = getCharacter('jonty'); // power 9
      const weak = getCharacter('joe'); // power 2
      const powerfulModule = createAutoPlayModule(createRng(55));
      const weakModule = createAutoPlayModule(createRng(55));
      // The aim vector exactly matches one of FIELD.POSTS (zone roll picks a
      // post index) — find that index and average it across many draws. A
      // higher average index means the skew favours later (deeper/wider) posts.
      function zoneIndexOf(aim: { x: number; z: number }): number {
        const idx = FIELD.POSTS.findIndex((p) => p.x === aim.x && p.z === aim.z);
        if (idx === -1) throw new Error('swing aim did not match any configured post');
        return idx;
      }
      let powerfulTotal = 0;
      let weakTotal = 0;
      for (let i = 0; i < N; i++) {
        const pAim = powerfulModule.swingDecision(powerful, GAME.BASE_TIMING_WINDOW).input.aim;
        const wAim = weakModule.swingDecision(weak, GAME.BASE_TIMING_WINDOW).input.aim;
        powerfulTotal += zoneIndexOf(pAim);
        weakTotal += zoneIndexOf(wAim);
      }
      expect(powerfulTotal / N).toBeGreaterThan(weakTotal / N);
    });

    it('returns a well-formed swing roll event', () => {
      const auto = createAutoPlayModule(createRng(8));
      const { roll } = auto.swingDecision(carl, GAME.BASE_TIMING_WINDOW);
      expect(roll.contest).toBe('swing');
      expect(roll.actorId).toBe(carl.id);
      expect(roll.roll).toBeGreaterThanOrEqual(0);
      expect(roll.roll).toBeLessThan(1);
      expect(typeof roll.detail).toBe('string');
      expect(roll.detail.length).toBeGreaterThan(0);
    });
  });

  describe('runDecision', () => {
    function pGoFormula(risk01: number, nerve: number): number {
      return Math.min(
        1,
        Math.max(0, GAME.AUTOPLAY_RUN_BASE + risk01 * 0.5 + GAME.AUTOPLAY_RUN_NERVE_W * (nerve / 10)),
      );
    }

    it('is exactly reproducible from the same seed', () => {
      const situation: RunSituation = { ballHeld: false, ballDistToTargetPost: 10 };
      const a = createAutoPlayModule(createRng(4));
      const b = createAutoPlayModule(createRng(4));
      expect(a.runDecision(carl, situation)).toEqual(b.runDecision(carl, situation));
    });

    it('pGo arithmetic pinned: ball held (risk01 = AUTOPLAY_RUN_HELD_RISK)', () => {
      const situation: RunSituation = { ballHeld: true, ballDistToTargetPost: 999 };
      const auto = createAutoPlayModule(createRng(2));
      const { roll } = auto.runDecision(carl, situation);
      const expectedPGo = pGoFormula(GAME.AUTOPLAY_RUN_HELD_RISK, carl.stats.nerve);
      expect(roll.threshold).toBeCloseTo(expectedPGo, 10);
    });

    it('pGo arithmetic pinned: ball free at 30m+ (risk01 saturates at 1)', () => {
      const situation: RunSituation = { ballHeld: false, ballDistToTargetPost: GAME.AUTOPLAY_RUN_DIST_REF };
      const auto = createAutoPlayModule(createRng(2));
      const { roll } = auto.runDecision(carl, situation);
      const expectedPGo = pGoFormula(1, carl.stats.nerve);
      expect(roll.threshold).toBeCloseTo(expectedPGo, 10);
    });

    it('pGo arithmetic pinned: ball free at 0m (risk01 = 0)', () => {
      const situation: RunSituation = { ballHeld: false, ballDistToTargetPost: 0 };
      const auto = createAutoPlayModule(createRng(2));
      const { roll } = auto.runDecision(carl, situation);
      const expectedPGo = pGoFormula(0, carl.stats.nerve);
      expect(roll.threshold).toBeCloseTo(expectedPGo, 10);
    });

    it('nerve extremes: carl (nerve 8) has a higher pGo than joe (nerve 2) in the same situation', () => {
      const situation: RunSituation = { ballHeld: false, ballDistToTargetPost: 15 };
      const autoCarl = createAutoPlayModule(createRng(9));
      const autoJoe = createAutoPlayModule(createRng(9));
      const carlRoll = autoCarl.runDecision(carl, situation).roll;
      const joeRoll = autoJoe.runDecision(joeNerve, situation).roll;
      expect(carlRoll.threshold).toBeGreaterThan(joeRoll.threshold);
    });

    it('go is true iff the roll is below the pGo threshold', () => {
      const situation: RunSituation = { ballHeld: false, ballDistToTargetPost: 12 };
      const auto = createAutoPlayModule(createRng(66));
      for (let i = 0; i < 100; i++) {
        const { go, roll } = auto.runDecision(carl, situation);
        expect(go).toBe(roll.roll < roll.threshold);
        expect(roll.success).toBe(go);
      }
    });

    it('returns a well-formed run roll event', () => {
      const situation: RunSituation = { ballHeld: false, ballDistToTargetPost: 5 };
      const auto = createAutoPlayModule(createRng(13));
      const { roll } = auto.runDecision(carl, situation);
      expect(roll.contest).toBe('run');
      expect(roll.actorId).toBe(carl.id);
      expect(roll.roll).toBeGreaterThanOrEqual(0);
      expect(roll.roll).toBeLessThan(1);
      expect(typeof roll.detail).toBe('string');
      expect(roll.detail.length).toBeGreaterThan(0);
    });
  });

  it('CHARACTERS import sanity (kian spin 9, joe spin 2, carl nerve 8)', () => {
    expect(kian.stats.spin).toBe(9);
    expect(joe.stats.spin).toBe(2);
    expect(carl.stats.nerve).toBe(8);
    expect(CHARACTERS.length).toBeGreaterThan(0);
  });
});
