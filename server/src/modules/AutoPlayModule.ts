/**
 * Auto-play dice-roll decisions (2026-07-05 redesign, design spec §2). Pure:
 * the injected rng is the only source of randomness, no side effects, no wall
 * clock. MatchRoom (Task 3) drives beats on sim time and threads these
 * decisions through the EXISTING resolvePitch/resolveSwing/RunningModule
 * paths verbatim — this module only picks the inputs and samples the timing
 * error; formulas/abilities/physics are untouched.
 *
 * DRAW-COUNT CONTRACT (fixed; deterministic replay depends on the exact
 * order — change this comment in lockstep with the implementation):
 *   - pitchDecision: 3 draws — [0] spin magnitude (stat-weighted), [1] spin
 *     sign, [2] aim scatter angle.
 *   - swingDecision: 2 draws — [0] timingError (uniform in
 *     ±AUTOPLAY_TIMING_NOISE_S), [1] aim zone roll (power-weighted across the
 *     legal fan of posts).
 *   - runDecision: 1 draw — the go/stay roll against pGo.
 */
import {
  CONST,
  s01,
  type Character,
  type PitchAbilityMods,
  type PitchInput,
  type RollEvent,
  type SwingInput,
} from '@carlquest/shared';

const { FIELD, GAME } = CONST;

export interface RunSituation {
  ballHeld: boolean;
  /** Metres from the ball to the post the runner is heading for. */
  ballDistToTargetPost: number;
}

/** Direction from the bowling square towards the batting square, at ground level. */
function pitchAimBase(): { x: number; y: number; z: number } {
  return {
    x: FIELD.BATTING_SQUARE.x - FIELD.BOWLING_SQUARE.x,
    y: 0,
    z: FIELD.BATTING_SQUARE.z - FIELD.BOWLING_SQUARE.z,
  };
}

/**
 * Rotate a horizontal (x, z) vector by a small angle (radians) — used for both
 * the pitch's aim scatter and the swing's zone spread. Keeps the vector's
 * horizontal magnitude; y is untouched by the caller afterwards.
 */
function rotateHorizontal(x: number, z: number, angleRad: number): { x: number; z: number } {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: x * cos - z * sin, z: x * sin + z * cos };
}

export function createAutoPlayModule(rng: () => number): {
  pitchDecision(pitcher: Character, mods: PitchAbilityMods): { input: PitchInput; roll: RollEvent };
  swingDecision(
    batter: Character,
    effectiveWindowS: number,
  ): { input: SwingInput; timingError: number; roll: RollEvent };
  runDecision(runner: Character, situation: RunSituation): { go: boolean; roll: RollEvent };
} {
  function pitchDecision(
    pitcher: Character,
    mods: PitchAbilityMods,
  ): { input: PitchInput; roll: RollEvent } {
    // Draw 0: spin magnitude, stat-weighted — a high spin stat makes a strong
    // (>=0.5) roll far likelier; a low spin stat mostly stays weak/straight.
    const magnitudeRoll = rng();
    const spinBias = s01(pitcher.stats.spin); // 0..1
    // magnitude = magnitudeRoll^(1 - spinBias * 0.85): higher spinBias flattens
    // the exponent towards 1 (linear, more mass at the top); low spinBias raises
    // the exponent (pulls the distribution towards 0 — mostly straight).
    const exponent = Math.max(0.15, 1 - spinBias * 0.85);
    const magnitude = Math.pow(magnitudeRoll, exponent);

    // Draw 1: sign, independent of magnitude.
    const sign = rng() < 0.5 ? -1 : 1;
    const spinInput = Math.max(-1, Math.min(1, magnitude * sign));

    // Draw 2: small aim scatter — rotate the straight-at-the-batter aim by a
    // few degrees either way, then clamp elevation via the pitch cap.
    const scatterRoll = rng();
    const maxScatterDeg = 6;
    const scatterDeg = (scatterRoll * 2 - 1) * maxScatterDeg;
    const base = pitchAimBase();
    const rotated = rotateHorizontal(base.x, base.z, scatterDeg * (Math.PI / 180));
    const aim = { x: rotated.x, y: 0, z: rotated.z };

    const detail = `spin ${pitcher.stats.spin}${spinInput >= 0 ? '+' : '-'} (${Math.abs(spinInput).toFixed(2)})`;
    const roll: RollEvent = {
      contest: 'pitch',
      actorId: pitcher.id,
      detail,
      roll: magnitudeRoll,
      threshold: spinBias,
      success: magnitude >= spinBias,
    };
    void mods; // reserved: pitch stat/curve mods are applied downstream by resolvePitch, not here.
    return { input: { aim, spinInput }, roll };
  }

  function swingDecision(
    batter: Character,
    effectiveWindowS: number,
  ): { input: SwingInput; timingError: number; roll: RollEvent } {
    // Draw 0: timingError, uniform in +/- AUTOPLAY_TIMING_NOISE_S.
    const timingRoll = rng();
    const timingError = (timingRoll * 2 - 1) * GAME.AUTOPLAY_TIMING_NOISE_S;

    // Draw 1: aim zone roll across the legal fan of posts, power-weighted so
    // high power biases towards the deeper/wider posts (later fan indices).
    const zoneRoll = rng();
    const posts = FIELD.POSTS;
    const powerBias = s01(batter.stats.power); // 0..1
    // Skew the uniform zoneRoll towards higher indices as power increases:
    // zoneIndexFraction = zoneRoll^(1 / (1 + powerBias*2)) pulls the mass up
    // towards 1 (deeper zones) for high power, stays closer to uniform at low power.
    const skewed = Math.pow(zoneRoll, 1 / (1 + powerBias * 2));
    const zoneIndex = Math.min(posts.length - 1, Math.floor(skewed * posts.length));
    const target = posts[zoneIndex] ?? posts[0];
    if (target === undefined) throw new RangeError('no posts configured for the swing aim fan');

    const spinInput = 0; // batter aim carries no sidespin intent in auto-play; kept for wire shape.
    const roll: RollEvent = {
      contest: 'swing',
      actorId: batter.id,
      detail: `timing ${timingError >= 0 ? '+' : ''}${timingError.toFixed(3)}s v window ${effectiveWindowS.toFixed(3)}s`,
      roll: Math.abs(timingError) / GAME.AUTOPLAY_TIMING_NOISE_S,
      threshold: effectiveWindowS,
      success: Math.abs(timingError) < effectiveWindowS,
    };
    return { input: { aim: { x: target.x, y: 0, z: target.z }, spinInput }, timingError, roll };
  }

  function runDecision(runner: Character, situation: RunSituation): { go: boolean; roll: RollEvent } {
    const risk01 = situation.ballHeld
      ? GAME.AUTOPLAY_RUN_HELD_RISK
      : Math.min(1, Math.max(0, situation.ballDistToTargetPost / GAME.AUTOPLAY_RUN_DIST_REF));
    const pGo = Math.min(
      1,
      Math.max(0, GAME.AUTOPLAY_RUN_BASE + risk01 * 0.5 + GAME.AUTOPLAY_RUN_NERVE_W * s01(runner.stats.nerve)),
    );
    const draw = rng();
    const go = draw < pGo;
    const roll: RollEvent = {
      contest: 'run',
      actorId: runner.id,
      detail: situation.ballHeld ? 'held ball — risky' : `ball ${situation.ballDistToTargetPost.toFixed(1)}m off`,
      roll: draw,
      threshold: pGo,
      success: go,
    };
    return { go, roll };
  }

  return { pitchDecision, swingDecision, runDecision };
}
