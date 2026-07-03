/**
 * Fielder AI (spec §1, Milestone 4): two-fielder pursuit, stats-driven catch
 * evaluation, and a delayed throw at the runner's target post. Fielders are
 * logical entities — never Rapier bodies — so the ball stays the physics
 * world's only dynamic body (M4 design doc). All randomness comes from the
 * injected rng; all physics side effects go through the injected deps.
 */
import {
  CONST,
  approachPenalty,
  catchRadius,
  fatigueMult,
  moveSpeed,
  pCatch,
  pitchSpeed,
  type BallState,
  type Character,
  type FielderSetup,
  type PitchParams,
  type Vec3,
} from '@carlquest/shared';

const { FIELD, GAME, PHYSICS } = CONST;

/** Numeric guards: float accumulation slack and a degenerate-direction threshold. */
const EPSILON = 1e-9;
const DEGENERATE_DISTANCE = 1e-6;

/**
 * Ability hooks (M9). The fields exist so the catch/throw paths already have
 * the right shape, but Milestone 4 uses only these neutral identity values —
 * no ability conditions are implemented (plan Global Constraints).
 */
interface AbilityParams {
  /** LONG_REACH widens the catch radius (M9). */
  radiusMult: number;
  /** A guaranteed catch skips the pCatch roll entirely (M9). */
  guaranteed: boolean;
  /** BUTTERFINGERS post-catch fumble probability (M9); 0 = never, so no fumble roll exists yet. */
  fumbleChance: number;
  /** QUICK_DRAW halves the gather-to-throw delay (M9). */
  releaseDelayMult: number;
}

const NEUTRAL: AbilityParams = {
  radiusMult: 1,
  guaranteed: false,
  fumbleChance: 0,
  releaseDelayMult: 1,
};

export interface FielderView {
  id: string;
  x: number;
  z: number;
  hasBall: boolean;
  stamina: number;
}

export interface FieldingDeps {
  /** Seeded rng in [0, 1) — catch rolls only; call counts are part of the contract. */
  rng: () => number;
  /** True once the ball has touched the ground this flight (caught vs gathered, spec §8). */
  hasBounced: () => boolean;
  /** Releases a throw; the room binds physics.applyPitch. */
  applyThrow: (params: PitchParams) => void;
  /** Parks the held ball at rest; the room binds physics.spawnBall. */
  holdBallAt: (pos: Vec3) => void;
}

export type FieldingEvent =
  | { kind: 'caught'; by: string } // pre-bounce catch (out)
  | { kind: 'gathered'; by: string } // post-bounce pickup
  | { kind: 'thrown'; by: string; atPost: number };

export interface FieldingModule {
  /**
   * Advance fielders by dt against the given ball snapshot. Returns at most
   * ONE event per call: catching requires no holder at tick start and throwing
   * requires one, so the two sources are mutually exclusive, and within the
   * catch pass the first successful fielder wins (later fielders in setup
   * order simply do not attempt that tick).
   */
  tick(
    dt: number,
    ball: BallState,
    ballLive: boolean,
    runnerTargetPost: number | null,
  ): FieldingEvent | null;
  getFielders(): FielderView[];
  holderId(): string | null;
  /** Back to setup positions and stat stamina; holder, hold timer and roll latches cleared. */
  reset(): void;
}

/**
 * Velocity vector that lands a projectile launched from `from` on `to` at
 * scalar `speed` under gravity alone — the LOW ballistic root, so throws are
 * flat darts rather than lobs: θ = atan((v² − √(v⁴ − g(gd² + 2·dy·v²))) / (gd)).
 * An out-of-range target (negative discriminant) falls back to 45° elevation
 * towards it (maximum range). Null when the target is horizontally degenerate.
 *
 * Aim heuristic only: the real flight has linear damping (and any residual
 * spin's Magnus force), so the ball lands slightly short of the solved point.
 * Good enough for post-directed throws; the post sensor is 0.5 m wide.
 */
export function throwVelocity(from: Vec3, to: Vec3, speed: number): Vec3 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < DEGENERATE_DISTANCE) return null;
  const dy = to.y - from.y;
  const g = -PHYSICS.GRAVITY_Y;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  const theta = disc >= 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * d)) : Math.PI / 4;
  const horizontal = speed * Math.cos(theta);
  return { x: (dx / d) * horizontal, y: speed * Math.sin(theta), z: (dz / d) * horizontal };
}

interface FielderState {
  readonly character: Character;
  /** Setup slot, restored by reset(). */
  readonly home: { x: number; z: number };
  x: number;
  z: number;
  stamina: number;
  hasBall: boolean;
  /**
   * Catch-roll latch: true from the tick the ball enters this fielder's catch
   * radius (below CATCH_HEIGHT_MAX) until it leaves — one pCatch roll per
   * entry (M4 user decision 2). Latches only update while a live, unheld ball
   * is in play; freezing them during a hold stops the thrower — whose latch is
   * still set from the catch — from rolling to re-catch their own throw as it
   * leaves their hands.
   */
  latched: boolean;
}

export function createFieldingModule(setup: FielderSetup[], deps: FieldingDeps): FieldingModule {
  const fielders: FielderState[] = setup.map((s) => ({
    character: s.character,
    home: { x: s.position.x, z: s.position.z },
    x: s.position.x,
    z: s.position.z,
    stamina: s.character.stats.stamina,
    hasBall: false,
    latched: false,
  }));

  let holder: FielderState | null = null;
  let holdTime = 0;

  /** A fielder's hands: feet position raised to ball-release height. */
  function handsOf(f: FielderState): Vec3 {
    return { x: f.x, y: PHYSICS.BALL_RELEASE_HEIGHT, z: f.z };
  }

  function post(n: number): { x: number; z: number } {
    const p = FIELD.POSTS[n - 1];
    if (p === undefined) throw new RangeError(`no post ${n}`);
    return p;
  }

  /**
   * Where the chaser should run to. Airborne ball: gravity-only ballistic
   * projection to y = BALL_RADIUS — Magnus is deliberately ignored, a pure AI
   * heuristic (curved hits are chased imperfectly; acceptable per the design
   * doc, and no determinism risk). A ball on/near the ground solves to t ≈ 0,
   * i.e. its current position, so no separate rolling branch is needed.
   */
  function predictGatherPoint(ball: BallState): { x: number; z: number } {
    const g = -PHYSICS.GRAVITY_Y;
    const height = ball.position.y - PHYSICS.BALL_RADIUS;
    const vy = ball.velocity.y;
    const disc = vy * vy + 2 * g * height;
    const t = disc > 0 ? Math.max(0, (vy + Math.sqrt(disc)) / g) : 0;
    return { x: ball.position.x + ball.velocity.x * t, z: ball.position.z + ball.velocity.z * t };
  }

  /** Nearest fielder to a 2D point, skipping exclusions; ties go to setup order (deterministic). */
  function nearestTo(point: { x: number; z: number }, exclude: FielderState[]): FielderState | null {
    let best: FielderState | null = null;
    let bestDist = Infinity;
    for (const f of fielders) {
      if (exclude.includes(f)) continue;
      const dist = (f.x - point.x) ** 2 + (f.z - point.z) ** 2;
      if (dist < bestDist) {
        best = f;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Stand POST_SENSOR_RADIUS short of the post on the fielder's own side — covering, not occupying, it. */
  function coverTarget(f: FielderState, postNumber: number): { x: number; z: number } {
    const p = post(postNumber);
    const dx = f.x - p.x;
    const dz = f.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < DEGENERATE_DISTANCE) return { x: p.x, z: p.z }; // already on the post: no offset direction
    return {
      x: p.x + (dx / d) * FIELD.POST_SENSOR_RADIUS,
      z: p.z + (dz / d) * FIELD.POST_SENSOR_RADIUS,
    };
  }

  /**
   * Sprint towards (tx, tz): speed comes from stamina at tick start, the
   * sprint drain lands afterwards; arrival within one frame's travel snaps to
   * the target. Standing on the target is not sprinting — no drain.
   */
  function moveTowards(f: FielderState, tx: number, tz: number, dt: number): void {
    const dx = tx - f.x;
    const dz = tz - f.z;
    const dist = Math.hypot(dx, dz);
    if (dist === 0) return;
    const travel = moveSpeed(f.character.stats.speed, fatigueMult(f.stamina)) * dt;
    if (dist <= travel) {
      f.x = tx;
      f.z = tz;
    } else {
      f.x += (dx / dist) * travel;
      f.z += (dz / dist) * travel;
    }
    f.stamina = Math.max(0, f.stamina - GAME.SPRINT_STAMINA_COST_PER_S * dt);
  }

  return {
    tick(dt, ball, ballLive, runnerTargetPost) {
      const heldAtStart = holder !== null;

      // --- Roles (re-evaluated every tick) + movement -----------------------
      if (holder === null) {
        const gather = predictGatherPoint(ball);
        const chaser = nearestTo(gather, []);
        if (chaser !== null) moveTowards(chaser, gather.x, gather.z, dt);
        if (runnerTargetPost !== null && chaser !== null) {
          const cover = nearestTo(gather, [chaser]); // next-nearest backs up the threatened post
          if (cover !== null) {
            const target = coverTarget(cover, runnerTargetPost);
            moveTowards(cover, target.x, target.z, dt);
          }
        }
      } else if (runnerTargetPost !== null) {
        // A held ball is chased by nobody; the free fielder nearest the
        // runner's target post still covers it, backing up the imminent throw.
        const cover = nearestTo(post(runnerTargetPost), [holder]);
        if (cover !== null) {
          const target = coverTarget(cover, runnerTargetPost);
          moveTowards(cover, target.x, target.z, dt);
        }
      }

      let event: FieldingEvent | null = null;

      // --- Catch evaluation (latches freeze while the ball is dead or held) --
      if (ballLive && holder === null) {
        const penalty = approachPenalty(
          Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z),
        );
        for (const f of fielders) {
          if (holder !== null) break; // first catch wins; later latches freeze until next tick
          const hands = handsOf(f);
          const radius = catchRadius(f.character.stats.reach) * NEUTRAL.radiusMult;
          const within =
            ball.position.y <= GAME.CATCH_HEIGHT_MAX &&
            Math.hypot(
              ball.position.x - hands.x,
              ball.position.y - hands.y,
              ball.position.z - hands.z,
            ) <= radius;
          if (!within) {
            f.latched = false;
            continue;
          }
          if (f.latched) continue; // already rolled this entry
          f.latched = true;
          const p = pCatch(f.character.stats.instinct, f.character.stats.reflex, penalty);
          // NEUTRAL.guaranteed short-circuits the roll when abilities land (M9);
          // false today, so exactly one rng draw happens per radius entry.
          const success = NEUTRAL.guaranteed || deps.rng() < p;
          if (!success) continue;
          f.hasBall = true;
          holder = f;
          holdTime = 0;
          // Read the bounce state BEFORE parking: holdBallAt is bound to
          // physics.spawnBall in the room, and placeBall resets the bounce
          // flag — reading it afterwards misclassified every post-bounce
          // pickup as a pre-bounce catch (M4 final-review regression).
          const bouncedBeforePark = deps.hasBounced();
          deps.holdBallAt(hands); // park immediately so physics cannot fly the ball onwards
          event = bouncedBeforePark
            ? { kind: 'gathered', by: f.character.id }
            : { kind: 'caught', by: f.character.id };
        }
      }

      // --- Held ball: park at the hands, throw after the release delay -------
      if (heldAtStart && holder !== null) {
        const f = holder;
        holdTime += dt;
        const hands = handsOf(f);
        deps.holdBallAt(hands);
        const releaseAfter = GAME.THROW_RELEASE_DELAY_S * NEUTRAL.releaseDelayMult;
        if (runnerTargetPost !== null && holdTime >= releaseAfter - EPSILON) {
          const p = post(runnerTargetPost);
          const velocity = throwVelocity(
            hands,
            { x: p.x, y: FIELD.POST_HEIGHT, z: p.z }, // aim at the top of the post
            pitchSpeed(f.character.stats.pitch),
          );
          if (velocity !== null) {
            deps.applyThrow({ origin: hands, velocity, angularVelocity: { x: 0, y: 0, z: 0 } });
            f.hasBall = false;
            f.stamina = Math.max(0, f.stamina - GAME.THROW_STAMINA_COST);
            holder = null;
            holdTime = 0;
            event = { kind: 'thrown', by: f.character.id, atPost: runnerTargetPost };
          }
          // Null velocity = degenerate geometry (holder standing on the post):
          // keep holding and retry next tick.
        }
        // No runner between posts → keep holding; the room ends the play at
        // rest/timeout.
      }

      return event;
    },

    getFielders() {
      return fielders.map((f) => ({
        id: f.character.id,
        x: f.x,
        z: f.z,
        hasBall: f.hasBall,
        stamina: f.stamina,
      }));
    },

    holderId() {
      return holder === null ? null : holder.character.id;
    },

    reset() {
      for (const f of fielders) {
        f.x = f.home.x;
        f.z = f.home.z;
        f.stamina = f.character.stats.stamina;
        f.hasBall = false;
        f.latched = false;
      }
      holder = null;
      holdTime = 0;
    },
  };
}
