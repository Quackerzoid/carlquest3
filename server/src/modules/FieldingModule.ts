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
  fieldingAbilityParams,
  moveSpeed,
  pCatch,
  pitchSpeed,
  pressureMult,
  type BallState,
  type Character,
  type FielderSetup,
  type FieldingAbilityParams,
  type PitchParams,
  type RollEvent,
  type Vec3,
} from '@carlquest/shared';

const { ABILITY, FIELD, GAME, PHYSICS } = CONST;

/** Numeric guards: float accumulation slack and a degenerate-direction threshold. */
const EPSILON = 1e-9;
const DEGENERATE_DISTANCE = 1e-6;

export interface FielderView {
  id: string;
  x: number;
  z: number;
  hasBall: boolean;
  stamina: number;
}

export interface FieldingDeps {
  /**
   * Seeded rng in [0, 1) — catch and fumble rolls only; call counts are part
   * of the contract: one pCatch roll per radius entry, EXCEPT none for a
   * guaranteed (IMMOVABLE) attempt, plus one extra fumble roll after a
   * won/guaranteed attempt only when the fielder's fumbleChance > 0 (M9).
   */
  rng: () => number;
  /** True once the ball has touched the ground this flight (caught vs gathered, spec §8). */
  hasBounced: () => boolean;
  /** Releases a throw; the room binds physics.applyPitch. */
  applyThrow: (params: PitchParams) => void;
  /** Parks the held ball at rest; the room binds physics.spawnBall. */
  holdBallAt: (pos: Vec3) => void;
  /**
   * True when RulesModule flags a high-pressure state (Milestone 5, spec §5);
   * absent (default) means no pressure is ever applied. Read once per catch
   * roll — same seam as the rng call it scales.
   */
  pressure?: () => boolean;
  /**
   * Dice-moment observer (2026-07-05 auto-play redesign): invoked with a
   * `catch`-contest RollEvent for EVERY catch attempt — the pCatch roll (the
   * actual draw v the effective probability), a guaranteed IMMOVABLE attempt
   * (success true, threshold 1, roll 0 — no rng draw), and the BUTTERFINGERS
   * fumble roll (success = held on; detail mentions the fumble). Purely
   * observational: presence or absence changes no behaviour and no rng draw
   * counts. The room binds a `roll` broadcast here.
   */
  onRoll?: (e: RollEvent) => void;
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
  /**
   * Catch arming (2026-07-05 readable-game overhaul; same family as the WALL
   * flight-start exemption): the room calls this at bat contact with the hit's
   * launch position. Until the ball has travelled CATCH_ARM_DISTANCE_M from
   * that origin, NO catch/gather attempt happens — and no rng is drawn (the
   * call-count contract in the test header). The exemption is ONE-WAY: the
   * first ball snapshot far enough from the origin arms the flight for good,
   * so a ball that later rolls back near the launch point is still fieldable.
   * Throw flights (applyThrow) never call this and are armed immediately —
   * relay catches stay live. Arming a fresh hit flight also clears the
   * thrown-flight tag (see thrownFlight). reset() clears any pending origin.
   */
  armFlight(origin: Vec3): void;
  /** Back to setup positions and stat stamina; holder, hold timer, roll latches, arming origin and the fumbled/thrown-flight flags cleared. */
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
  /** Ability params derived once at setup from the character (M9). */
  readonly params: FieldingAbilityParams;
  /** Setup slot, restored by reset(). */
  readonly home: { x: number; z: number };
  /** Setup stamina (the M8 ledger seed; stat when unseeded), restored by reset(). */
  readonly seedStamina: number;
  x: number;
  z: number;
  stamina: number;
  hasBall: boolean;
  /**
   * This tick's movement speed in m/s (last step distance / dt), zeroed at
   * tick start for fielders nobody moves. Feeds LONG_REACH's stationary check:
   * the widened radius applies only while speed < ABILITY.STATIONARY_SPEED_EPS.
   */
  speed: number;
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
    params: fieldingAbilityParams(s.character),
    home: { x: s.position.x, z: s.position.z },
    seedStamina: s.stamina ?? s.character.stats.stamina,
    x: s.position.x,
    z: s.position.z,
    stamina: s.stamina ?? s.character.stats.stamina,
    hasBall: false,
    speed: 0,
    latched: false,
  }));

  let holder: FielderState | null = null;
  let holdTime = 0;
  /**
   * BUTTERFINGERS guard (M9): true from the first fumble of a flight until
   * reset(). A fumbled ball touched the ground by definition, so any later
   * successful catch this flight classifies gathered, never caught — the
   * room binds holdBallAt to physics.spawnBall, whose placeBall resets the
   * bounce flag, so deps.hasBounced() alone would report the grounded ball
   * as never-bounced and hand out a wrongful pre-bounce out.
   */
  let fumbledFlight = false;
  /**
   * Thrown-flight guard (2026-07-05 relay-reception fix; same shape as
   * fumbledFlight above): true from the module's own applyThrow release until
   * a NEW hit flight arms (armFlight) or reset(). Spec §8's pre-bounce
   * `caught` out is about the BATTER's struck ball — catching a teammate's
   * throw is a reception, not a dismissal — but the room binds applyThrow to
   * physics.applyPitch, whose placeBall resets the bounce flag, so a flat
   * relay dart genuinely arrives "never bounced" and deps.hasBounced() alone
   * classified a won reception as `caught`, wrongfully outing the batter.
   * While thrownFlight is true, every won attempt classifies gathered, never
   * caught. This closes the §6.4 thrown-ball item and, for THROWN flights,
   * its WALL 2.5–2.6 m band-edge cousin (a dart stopped dead by the blocker
   * above catch height can no longer manufacture a `caught` on the drop).
   */
  let thrownFlight = false;
  /**
   * Catch-arming origin (2026-07-05): non-null while the current HIT flight is
   * still within CATCH_ARM_DISTANCE_M of its launch point — every catch/gather
   * attempt (and its rng draw) is suppressed until then. Cleared one-way the
   * first tick the ball is far enough out (see armFlight's interface doc), by
   * reset(), and never set for throw flights.
   */
  let unarmedOrigin: Vec3 | null = null;

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
    if (dist === 0) return; // standing on the target: not sprinting, speed stays 0
    // POWERHOUSE (M9): fatigueMult forced to 1 while stamina >= fatigueFloor.
    // The neutral floor is Infinity, so everyone else always takes fatigueMult.
    const fatigue = f.stamina >= f.params.fatigueFloor ? 1 : fatigueMult(f.stamina);
    const travel = moveSpeed(f.character.stats.speed, fatigue) * dt;
    if (dist <= travel) {
      f.x = tx;
      f.z = tz;
    } else {
      f.x += (dx / dist) * travel;
      f.z += (dz / dist) * travel;
    }
    f.speed = dt > 0 ? Math.min(dist, travel) / dt : 0; // this tick's actual speed (LONG_REACH)
    f.stamina = Math.max(0, f.stamina - GAME.SPRINT_STAMINA_COST_PER_S * dt);
  }

  return {
    tick(dt, ball, ballLive, runnerTargetPost) {
      const heldAtStart = holder !== null;

      // Fielders nobody moves this tick are stationary; moveTowards overwrites.
      for (const f of fielders) f.speed = 0;

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

      // Catch arming (2026-07-05): a hit flight is uncatchable until it has
      // travelled CATCH_ARM_DISTANCE_M from its launch point — the backstop
      // can no longer instant-catch the ball on the contact tick (the ball
      // used to START inside her radius, so the entry roll fired before the
      // ball visibly left the bat). One-way: arming never re-suppresses.
      if (unarmedOrigin !== null) {
        const travelled = Math.hypot(
          ball.position.x - unarmedOrigin.x,
          ball.position.y - unarmedOrigin.y,
          ball.position.z - unarmedOrigin.z,
        );
        if (travelled >= GAME.CATCH_ARM_DISTANCE_M) unarmedOrigin = null;
      }

      // --- Catch evaluation (latches freeze while the ball is dead or held,
      // --- and the whole pass is suppressed while the flight is unarmed) ----
      if (ballLive && holder === null && unarmedOrigin === null) {
        const penalty = approachPenalty(
          Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z),
        );
        for (const f of fielders) {
          if (holder !== null) break; // first catch wins; later latches freeze until next tick
          const a = f.params;
          const hands = handsOf(f);
          // Effective radius (M9): base × static mult × (LONG_REACH's mult only
          // while this fielder is stationary), then POWERHOUSE's additive bonus
          // AFTER the multipliers.
          const stationary = f.speed < ABILITY.STATIONARY_SPEED_EPS;
          const radius =
            catchRadius(f.character.stats.reach) *
              a.radiusMult *
              (stationary ? a.stationaryRadiusMult : 1) +
            a.radiusBonusM;
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
          let p = pCatch(f.character.stats.instinct, f.character.stats.reflex, penalty);
          if (deps.pressure?.()) p *= pressureMult(f.character.stats.nerve);
          // IMMOVABLE (M9): a guaranteed attempt short-circuits the roll — NO
          // rng draw; otherwise exactly one draw per radius entry (contract).
          // Each attempt reports its dice moment through the optional onRoll
          // dep (auto-play redesign): the guaranteed case as a threshold-1
          // roll-0 certainty, the normal case with the real draw v pCatch.
          let success: boolean;
          if (a.guaranteed) {
            success = true;
            deps.onRoll?.({
              contest: 'catch',
              actorId: f.character.id,
              detail: 'guaranteed (IMMOVABLE)',
              roll: 0,
              threshold: 1,
              success: true,
            });
          } else {
            const draw = deps.rng();
            success = draw < p;
            deps.onRoll?.({
              contest: 'catch',
              actorId: f.character.id,
              detail: `pCatch ${p.toFixed(2)}`,
              roll: draw,
              threshold: p,
              success,
            });
          }
          if (!success) continue;
          // BUTTERFINGERS (M9): one EXTRA rng draw after a won (or guaranteed)
          // attempt, only when fumbleChance > 0 — neutral counts unchanged.
          if (a.fumbleChance > 0) {
            const fumbleDraw = deps.rng();
            const fumbled = fumbleDraw < a.fumbleChance;
            deps.onRoll?.({
              contest: 'catch',
              actorId: f.character.id,
              detail: fumbled ? 'fumbled the take' : 'held on through the fumble check',
              roll: fumbleDraw,
              threshold: a.fumbleChance,
              success: !fumbled, // success = the fielder kept hold
            });
            if (fumbled) {
              // Fumble: the ball drops dead at the fielder's FEET on the ground —
              // parked but NOT held (no holder), so play simply continues. The
              // entry latch stays set (no instant re-roll on the parked ball),
              // and fumbledFlight forces every later catch this flight to
              // classify gathered (see the flag's declaration).
              fumbledFlight = true;
              deps.holdBallAt({ x: f.x, y: PHYSICS.BALL_RADIUS, z: f.z });
              break; // the ball snapshot is stale for everyone else this tick
            }
          }
          f.hasBall = true;
          holder = f;
          holdTime = 0;
          // Read the bounce state BEFORE parking: holdBallAt is bound to
          // physics.spawnBall in the room, and placeBall resets the bounce
          // flag — reading it afterwards misclassified every post-bounce
          // pickup as a pre-bounce catch (M4 final-review regression).
          const bouncedBeforePark = deps.hasBounced();
          deps.holdBallAt(hands); // park immediately so physics cannot fly the ball onwards
          event =
            bouncedBeforePark || fumbledFlight || thrownFlight
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
        // QUICK_DRAW (M9): the holder's own releaseDelayMult halves the delay.
        const releaseAfter = GAME.THROW_RELEASE_DELAY_S * f.params.releaseDelayMult;
        if (runnerTargetPost !== null && holdTime >= releaseAfter - EPSILON) {
          const p = post(runnerTargetPost);
          // Relay throws (2026-07-05): a teammate F (never the holder — the
          // qualifying inequality is unsatisfiable for him anyway) qualifies
          // when dist(F, P) + RELAY_ADVANTAGE_M < dist(holder, P) AND
          // dist(F, P) < the holder's direct throw distance to P (the second
          // condition is implied by the first while the advantage is positive;
          // kept as coded spec fidelity). The nearest-to-post qualifier wins,
          // and the throw targets that fielder's CURRENT position at hands
          // height — they gather on arrival via normal radius entry and
          // re-throw next hold cycle. One-hop logic only (no planning). The
          // emitted event still names the threatened post.
          const holderDist = Math.hypot(f.x - p.x, f.z - p.z);
          let relay: FielderState | null = null;
          let relayDist = Infinity;
          for (const other of fielders) {
            if (other === f) continue;
            const d = Math.hypot(other.x - p.x, other.z - p.z);
            if (d + GAME.RELAY_ADVANTAGE_M < holderDist && d < holderDist && d < relayDist) {
              relay = other;
              relayDist = d;
            }
          }
          const target =
            relay !== null
              ? { x: relay.x, y: PHYSICS.BALL_RELEASE_HEIGHT, z: relay.z } // at the relay fielder's hands
              : { x: p.x, y: FIELD.POST_HEIGHT, z: p.z }; // aim at the top of the post
          const velocity = throwVelocity(hands, target, pitchSpeed(f.character.stats.pitch));
          if (velocity !== null) {
            deps.applyThrow({ origin: hands, velocity, angularVelocity: { x: 0, y: 0, z: 0 } });
            thrownFlight = true; // this flight is a throw: any pickup is a reception (see the flag)
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

    armFlight(origin) {
      unarmedOrigin = { x: origin.x, y: origin.y, z: origin.z }; // defensive copy
      thrownFlight = false; // a fresh HIT flight: pre-bounce catches are outs again
    },

    reset() {
      for (const f of fielders) {
        f.x = f.home.x;
        f.z = f.home.z;
        f.stamina = f.seedStamina;
        f.hasBall = false;
        f.speed = 0;
        f.latched = false;
      }
      holder = null;
      holdTime = 0;
      fumbledFlight = false;
      thrownFlight = false;
      unarmedOrigin = null;
    },
  };
}
