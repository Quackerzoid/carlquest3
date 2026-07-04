/**
 * rng call-count CONTRACT (M4, extended M9): exactly ONE pCatch roll per
 * catch-radius entry (the entry latch suppresses re-rolls while inside),
 * EXCEPT: a guaranteed attempt (IMMOVABLE) makes NO pCatch roll at all; and a
 * fielder with fumbleChance > 0 (BUTTERFINGERS) makes ONE EXTRA fumble roll
 * immediately after a won (or guaranteed) attempt — fumbleChance = 0 fielders
 * never make that extra call, so neutral call counts are unchanged from M4.
 */
import { describe, expect, it } from 'vitest';
import {
  CONST,
  catchRadius,
  getCharacter,
  moveSpeed,
  fatigueMult,
  pCatch,
  pitchSpeed,
  pressureMult,
  type BallState,
  type FielderSetup,
  type PitchParams,
  type Vec3,
} from '@carlquest/shared';
import {
  createFieldingModule,
  throwVelocity,
  type FieldingDeps,
  type FielderView,
} from '../src/modules/FieldingModule';

const { FIELD, GAME, PHYSICS } = CONST;
const DT = PHYSICS.FIXED_TIMESTEP;

const carl = getCharacter('carl'); // speed 7, reach 6, pitch 5, stamina 7, instinct 6, reflex 6 → pCatch 0.72 - penalty; CLUTCH_SWING = neutral for fielding
const josh = getCharacter('josh'); // speed 8, reach 7, stamina 7; QUICK_DRAW (halved release delay, M9)
const joe = getCharacter('joe'); // speed 2, stamina 3 — fatigues immediately; BUTTERFINGERS (fumble roll, M9)

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const zero = vec(0, 0, 0);
const ball = (position: Vec3, velocity: Vec3 = zero): BallState => ({
  position,
  velocity,
  angularVelocity: zero,
});
/** A ball at rest height (rolling/stationary on the ground). */
const rolling = (x: number, z: number, velocity: Vec3 = zero): BallState =>
  ball(vec(x, PHYSICS.BALL_RADIUS, z), velocity);
const at = (character: typeof carl, x: number, z: number): FielderSetup => ({
  character,
  position: { x, z },
});

/** Deps stub: rng is a preset queue (default value is a miss for every real roster pCatch). */
function makeDeps(queue: number[] = []) {
  const rngQueue = [...queue];
  let rngCalls = 0;
  const throws: PitchParams[] = [];
  const holds: Vec3[] = [];
  const bounced = { value: false };
  const deps: FieldingDeps = {
    rng: () => {
      rngCalls += 1;
      const next = rngQueue.shift();
      return next === undefined ? 0.999 : next;
    },
    hasBounced: () => bounced.value,
    applyThrow: (p) => {
      throws.push(p);
    },
    holdBallAt: (p) => {
      holds.push({ ...p });
    },
  };
  return { deps, throws, holds, bounced, rngCallCount: () => rngCalls };
}

function view(m: { getFielders(): FielderView[] }, i = 0): FielderView {
  const f = m.getFielders()[i];
  if (f === undefined) throw new Error(`no fielder at index ${i}`);
  return f;
}

/** Test-side copy of the gravity-only landing projection (Magnus ignored, like the module). */
function landingPoint(b: BallState): { x: number; z: number } {
  const g = -PHYSICS.GRAVITY_Y;
  const height = b.position.y - PHYSICS.BALL_RADIUS;
  const disc = b.velocity.y * b.velocity.y + 2 * g * height;
  const t = disc > 0 ? Math.max(0, (b.velocity.y + Math.sqrt(disc)) / g) : 0;
  return { x: b.position.x + b.velocity.x * t, z: b.position.z + b.velocity.z * t };
}

const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

describe('throwVelocity', () => {
  it('low-arc solve lands a 10 m throw within 0.2 m under gravity-only integration', () => {
    // Gravity-only analytic flight; the real physics adds damping, so the
    // helper is an aim heuristic — the plan's 0.2 m tolerance reflects that.
    const from = vec(0, 1, 0);
    const to = vec(10, FIELD.POST_HEIGHT, 0);
    const speed = 20;
    const v = throwVelocity(from, to, speed);
    expect(v).not.toBeNull();
    if (v === null) return;
    expect(len(v)).toBeCloseTo(speed, 8);
    const t = (to.x - from.x) / v.x;
    const y = from.y + v.y * t + 0.5 * PHYSICS.GRAVITY_Y * t * t;
    expect(Math.abs(y - to.y)).toBeLessThan(0.2);
    // Low root: flatter than 45° when the target is comfortably in range.
    expect(v.y).toBeLessThan(Math.hypot(v.x, v.z));
  });

  it('falls back to 45° elevation towards the target when out of range', () => {
    const v = throwVelocity(vec(0, 1, 0), vec(50, 1, 0), 12); // max range ≈ 14.7 m < 50 m
    expect(v).not.toBeNull();
    if (v === null) return;
    expect(len(v)).toBeCloseTo(12, 8);
    expect(v.y).toBeCloseTo(Math.hypot(v.x, v.z), 8); // 45°: vertical = horizontal
    expect(v.x).toBeGreaterThan(0);
    expect(v.z).toBeCloseTo(0, 8);
  });

  it('returns null for horizontally degenerate geometry', () => {
    expect(throwVelocity(vec(1, 1, 1), vec(1, 1, 1), 20)).toBeNull();
    expect(throwVelocity(vec(0, 1, 0), vec(0, 5, 0), 20)).toBeNull(); // straight up: no horizontal direction
  });
});

describe('role assignment', () => {
  it('chaser is the fielder nearest the predicted landing point, not the ball (airborne)', () => {
    const b = ball(vec(0, 5, 10), vec(8, 2, 0)); // lands around x ≈ 9.84, z = 10
    const land = landingPoint(b);
    expect(land.x).toBeGreaterThan(9);
    const { deps } = makeDeps();
    const m = createFieldingModule([at(carl, 5, 10), at(josh, 0.2, 10)], deps);
    m.tick(DT, b, true, null);
    // Carl (5, 10) is nearer the landing than Josh (0.2, 10), who is nearer the ball itself.
    const a = view(m, 0);
    const bView = view(m, 1);
    expect(a.x).toBeCloseTo(5 + moveSpeed(carl.stats.speed, 1) * DT, 8); // runs +x towards the landing
    expect(a.z).toBeCloseTo(10, 8);
    expect(bView.x).toBe(0.2); // no runner between posts → no cover; holds
    expect(bView.z).toBe(10);
  });

  it('chaser is the fielder nearest the ball itself when it is rolling', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(carl, 5, 10), at(josh, 0.2, 10)], deps);
    m.tick(DT, rolling(0, 10), true, null);
    const a = view(m, 0);
    const bView = view(m, 1);
    expect(a.x).toBe(5); // Carl holds
    expect(bView.x).toBeCloseTo(0.2 - Math.min(0.2, moveSpeed(josh.stats.speed, 1) * DT), 8); // Josh closes -x
    expect(bView.z).toBeCloseTo(10, 8);
  });

  it('cover moves to the runner target post offset towards their own position; holds when no runner', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(carl, 0.5, 10), at(josh, 10, 17)], deps);
    // Post 3 is at (-3, 17); Josh approaches from +x, so his target is (-2.5, 17).
    m.tick(DT, rolling(0, 10), true, 3);
    const cover = view(m, 1);
    expect(cover.x).toBeCloseTo(10 - moveSpeed(josh.stats.speed, 1) * DT, 8);
    expect(cover.z).toBeCloseTo(17, 8);

    const { deps: deps2 } = makeDeps();
    const m2 = createFieldingModule([at(carl, 0.5, 10), at(josh, 10, 17)], deps2);
    m2.tick(DT, rolling(0, 10), true, null);
    expect(view(m2, 1).x).toBe(10); // nobody between posts → no cover
  });

  it('cover snaps to rest exactly POST_SENSOR_RADIUS short of the post', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(carl, 0.5, 10), at(josh, 10, 17)], deps);
    for (let i = 0; i < 40; i++) m.tick(0.1, rolling(0, 10), true, 3);
    const cover = view(m, 1);
    const post3 = FIELD.POSTS[2];
    if (post3 === undefined) throw new Error('no post 3');
    expect(cover.x).toBe(post3.x + FIELD.POST_SENSOR_RADIUS); // straight-line approach along +x
    expect(cover.z).toBe(post3.z);
  });
});

describe('movement and stamina', () => {
  it('a mover covers exactly moveSpeed·dt at full stamina and drains SPRINT_STAMINA_COST_PER_S·dt', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(josh, 0, 0)], deps);
    m.tick(DT, rolling(100, 0), true, null);
    const f = view(m);
    expect(f.x).toBeCloseTo(moveSpeed(josh.stats.speed, fatigueMult(josh.stats.stamina)) * DT, 10);
    expect(f.z).toBe(0);
    expect(f.stamina).toBeCloseTo(josh.stats.stamina - GAME.SPRINT_STAMINA_COST_PER_S * DT, 10);
  });

  it('a drained fielder slows via fatigueMult (speed computed from stamina at tick start)', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(joe, 0, 0)], deps);
    let expectedX = 0;
    let stamina = joe.stats.stamina; // 3 — any drain drops him below the fatigue knee
    let firstStep = 0;
    let lastStep = 0;
    for (let i = 0; i < 5; i++) {
      const step = moveSpeed(joe.stats.speed, fatigueMult(stamina)) * 1;
      if (i === 0) firstStep = step;
      lastStep = step;
      expectedX += step;
      stamina = Math.max(0, stamina - GAME.SPRINT_STAMINA_COST_PER_S * 1);
      m.tick(1, rolling(1000, 0), true, null);
    }
    const f = view(m);
    expect(f.x).toBeCloseTo(expectedX, 8);
    expect(f.stamina).toBeCloseTo(stamina, 10);
    expect(lastStep).toBeLessThan(firstStep);
  });
});

describe('catch evaluation', () => {
  it('rolls the rng exactly once on radius entry, not while latched, and again after exit/re-entry', () => {
    const h = makeDeps(); // default rng 0.999 — always a miss
    const m = createFieldingModule([at(carl, 0, 0)], h.deps);
    const inHands = ball(vec(0, PHYSICS.BALL_RELEASE_HEIGHT, 0));
    m.tick(DT, inHands, true, null);
    expect(h.rngCallCount()).toBe(1); // entry roll
    m.tick(DT, inHands, true, null);
    expect(h.rngCallCount()).toBe(1); // latched: no re-roll while inside
    m.tick(DT, rolling(100, 100), true, null); // ball leaves the radius
    expect(h.rngCallCount()).toBe(1);
    const f = view(m); // Carl chased a little; re-enter at his current hands
    m.tick(DT, ball(vec(f.x, PHYSICS.BALL_RELEASE_HEIGHT, f.z)), true, null);
    expect(h.rngCallCount()).toBe(2); // fresh entry → fresh roll
  });

  it('a successful roll before the bounce is a caught event and the fielder holds the ball', () => {
    const h = makeDeps([0]);
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toEqual({ kind: 'caught', by: 'carl' });
    expect(m.holderId()).toBe('carl');
    expect(view(m).hasBall).toBe(true);
    // The ball is parked at the hands immediately so physics cannot fly it onwards.
    expect(h.holds).toEqual([vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)]);
  });

  it('a successful roll after the bounce is a gathered event', () => {
    const h = makeDeps([0]);
    h.bounced.value = true;
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toEqual({ kind: 'gathered', by: 'carl' });
    expect(m.holderId()).toBe('carl');
  });

  it('reads hasBounced BEFORE parking the ball (holdBallAt resets bounce tracking)', () => {
    // Regression (M4 final-review round): the room binds holdBallAt to
    // physics.spawnBall, whose placeBall resets the bounce flag — evaluating
    // hasBounced() only after holdBallAt() misclassified every post-bounce
    // pickup as a pre-bounce 'caught' (a wrongful out). Couple the stubs the
    // way the real PhysicsModule couples them to pin the read order.
    const h = makeDeps([0]);
    h.bounced.value = true;
    const parkAndReset = h.deps.holdBallAt;
    h.deps.holdBallAt = (p) => {
      h.bounced.value = false; // exactly what placeBall does
      parkAndReset(p);
    };
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toEqual({ kind: 'gathered', by: 'carl' });
  });

  it('a failed roll produces no event and no holder', () => {
    const h = makeDeps([0.999]); // Carl pCatch ≤ 0.72 → miss
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toBeNull();
    expect(m.holderId()).toBeNull();
    expect(h.rngCallCount()).toBe(1);
  });

  it('a ball above CATCH_HEIGHT_MAX is over everyone: no roll even inside the radius', () => {
    const h = makeDeps();
    const m = createFieldingModule([at(carl, 0, 0)], h.deps);
    // 3D distance hands→ball = 2.0 ≤ catchRadius(6) = 2.12, but y = 3 > 2.5.
    const event = m.tick(DT, ball(vec(0, GAME.CATCH_HEIGHT_MAX + 0.5, 0)), true, null);
    expect(event).toBeNull();
    expect(h.rngCallCount()).toBe(0);
  });

  it('a dead ball is never attempted', () => {
    const h = makeDeps();
    const m = createFieldingModule([at(carl, 0, 0)], h.deps);
    const event = m.tick(DT, ball(vec(0, PHYSICS.BALL_RELEASE_HEIGHT, 0)), false, null);
    expect(event).toBeNull();
    expect(h.rngCallCount()).toBe(0);
  });
});

describe('held ball and throwing', () => {
  const HANDS = vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5);

  /** Catch the ball with Carl at (5, 5) on tick one; returns the harness + module. */
  function catchWithCarl() {
    const h = makeDeps([0]);
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const caught = m.tick(DT, ball(HANDS), true, null);
    expect(caught).toEqual({ kind: 'caught', by: 'carl' });
    return { h, m };
  }

  it('parks the ball at the hands every tick and keeps holding while no runner is between posts', () => {
    const { h, m } = catchWithCarl();
    for (let i = 0; i < 10; i++) {
      expect(m.tick(0.25, ball(HANDS), true, null)).toBeNull();
    }
    expect(h.holds).toHaveLength(11); // catch tick + 10 holding ticks
    for (const p of h.holds) expect(p).toEqual(HANDS);
    expect(h.throws).toHaveLength(0);
    expect(m.holderId()).toBe('carl');
  });

  it('releases the throw only after THROW_RELEASE_DELAY_S, at pitchSpeed towards the post', () => {
    const { h, m } = catchWithCarl();
    // dt 0.25 (exact in binary): one tick holds 0.25 s < 0.5 s, the second reaches the delay.
    expect(m.tick(0.25, ball(HANDS), true, 2)).toBeNull();
    const event = m.tick(0.25, ball(HANDS), true, 2);
    expect(event).toEqual({ kind: 'thrown', by: 'carl', atPost: 2 });
    expect(m.holderId()).toBeNull();
    expect(view(m).hasBall).toBe(false);
    expect(h.throws).toHaveLength(1);
    const t = h.throws[0];
    if (t === undefined) throw new Error('no throw recorded');
    expect(t.origin).toEqual(HANDS);
    expect(t.angularVelocity).toEqual(zero);
    expect(len(t.velocity)).toBeCloseTo(pitchSpeed(carl.stats.pitch), 8);
    // Horizontal direction points at post 2 = (9, 15): (dx, dz) = (4, 10).
    expect(t.velocity.x / t.velocity.z).toBeCloseTo(4 / 10, 8);
    expect(t.velocity.x).toBeGreaterThan(0);
    expect(t.velocity.z).toBeGreaterThan(0);
  });

  it('drains THROW_STAMINA_COST on release', () => {
    const { m } = catchWithCarl(); // Carl never sprinted: stamina still 7
    m.tick(0.25, ball(HANDS), true, 2);
    m.tick(0.25, ball(HANDS), true, 2);
    expect(view(m).stamina).toBeCloseTo(carl.stats.stamina - GAME.THROW_STAMINA_COST, 10);
  });

  it('a runner appearing after the delay has elapsed triggers an immediate throw', () => {
    const { h, m } = catchWithCarl();
    for (let i = 0; i < 8; i++) m.tick(0.25, ball(HANDS), true, null); // 2 s held, no target
    const event = m.tick(0.25, ball(HANDS), true, 4);
    expect(event).toEqual({ kind: 'thrown', by: 'carl', atPost: 4 });
    expect(h.throws).toHaveLength(1);
  });

  it('while a fielder holds the ball nobody chases it', () => {
    const h = makeDeps([0]);
    const m = createFieldingModule([at(carl, 5, 5), at(josh, 20, 20)], h.deps);
    m.tick(DT, ball(HANDS), true, null); // Carl catches
    m.tick(DT, ball(HANDS), true, null);
    expect(view(m, 1).x).toBe(20); // Josh does not chase the held ball
    expect(view(m, 1).z).toBe(20);
  });
});

describe('reset', () => {
  it('restores setup positions and stamina, clears the holder and the roll latches', () => {
    const h = makeDeps([0, 0]);
    const m = createFieldingModule([at(carl, 1, 2), at(josh, 30, 30)], h.deps);
    m.tick(DT, ball(vec(1, PHYSICS.BALL_RELEASE_HEIGHT, 2)), true, null); // Carl catches (rng 0)
    expect(m.holderId()).toBe('carl');
    m.reset();
    expect(m.holderId()).toBeNull();
    const a = view(m, 0);
    const b = view(m, 1);
    expect([a.x, a.z, b.x, b.z]).toEqual([1, 2, 30, 30]);
    expect(a.stamina).toBe(carl.stats.stamina);
    expect(b.stamina).toBe(josh.stats.stamina);
    expect(a.hasBall).toBe(false);
    // Latch cleared: the same ball position counts as a fresh entry and rolls again.
    const event = m.tick(DT, ball(vec(1, PHYSICS.BALL_RELEASE_HEIGHT, 2)), true, null);
    expect(event).toEqual({ kind: 'caught', by: 'carl' });
    expect(h.rngCallCount()).toBe(2);
  });

  it('getFielders exposes character ids, setup positions and stat stamina initially', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(carl, 1, 2), at(josh, 3, 4)], deps);
    expect(m.getFielders()).toEqual([
      { id: 'carl', x: 1, z: 2, hasBall: false, stamina: carl.stats.stamina },
      { id: 'josh', x: 3, z: 4, hasBall: false, stamina: josh.stats.stamina },
    ]);
  });
});

describe('pressure (M5)', () => {
  // Carl: instinct 6, reflex 6, ball stationary (approachPenalty 0) → base pCatch 0.72.
  // Carl nerve 8 → pressureMult(8) = 0.97 → pressured pCatch 0.6984.
  const base = pCatch(carl.stats.instinct, carl.stats.reflex, 0);
  const pressured = base * pressureMult(carl.stats.nerve);
  // Strictly between the two thresholds: rng < base (catches without pressure)
  // but rng >= pressured (misses with pressure) — the deterministic seam.
  const rngValue = (base + pressured) / 2;

  it('sanity: the chosen rng value sits strictly between pressured and base pCatch', () => {
    expect(rngValue).toBeGreaterThan(pressured);
    expect(rngValue).toBeLessThan(base);
  });

  it('without pressure the roll succeeds (catch)', () => {
    const h = makeDeps([rngValue]);
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toEqual({ kind: 'caught', by: 'carl' });
  });

  it('with pressure=true the same rng value now fails (pCatch scaled by pressureMult(nerve))', () => {
    const h = makeDeps([rngValue]);
    h.deps.pressure = () => true;
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toBeNull();
    expect(m.holderId()).toBeNull();
  });

  it('omitting pressure entirely (no deps.pressure key) behaves exactly like pressure absent', () => {
    const h = makeDeps([rngValue]);
    expect(h.deps.pressure).toBeUndefined();
    const m = createFieldingModule([at(carl, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toEqual({ kind: 'caught', by: 'carl' });
  });
});

describe('stamina seed (M8 ledger)', () => {
  it('a seeded stamina overrides the stat initially AND after reset()', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([{ ...at(carl, 0, 0), stamina: 2 }], deps);
    expect(view(m).stamina).toBe(2); // seeded, not carl's stat (7)
    m.tick(DT, rolling(50, 50), true, null); // sprint one tick so stamina moves off the seed
    expect(view(m).stamina).toBeLessThan(2);
    m.reset();
    expect(view(m).stamina).toBe(2); // reset restores the SEED, not the stat
  });

  it('an absent stamina field still defaults to the character stat', () => {
    const { deps } = makeDeps();
    const m = createFieldingModule([at(carl, 0, 0)], deps);
    expect(view(m).stamina).toBe(carl.stats.stamina);
    m.tick(DT, rolling(50, 50), true, null);
    m.reset();
    expect(view(m).stamina).toBe(carl.stats.stamina);
  });
});

describe('abilities (M9)', () => {
  const jonty = getCharacter('jonty'); // IMMOVABLE — guaranteed catch, NO pCatch roll
  const laurie = getCharacter('laurie'); // LONG_REACH — reach 9; ×1.4 radius while stationary only
  const ricy = getCharacter('ricy'); // POWERHOUSE — reach 8, speed 7 (same as carl); +0.5 m radius, no fatigue while stamina ≥ 2
  const { ABILITY } = CONST;

  /**
   * An airborne ball at hands height, horizontal distance d from a fielder
   * standing at (0, 0), moving so its gravity-only landing point is exactly
   * (0, 0): the fielder is already at the chase target (no movement → speed 0,
   * i.e. stationary) while the ball's 3D hands→ball distance is exactly d.
   */
  function incomingAt(d: number): BallState {
    const height = PHYSICS.BALL_RELEASE_HEIGHT - PHYSICS.BALL_RADIUS;
    const t = Math.sqrt((2 * height) / -PHYSICS.GRAVITY_Y);
    return ball(vec(d, PHYSICS.BALL_RELEASE_HEIGHT, 0), vec(-d / t, 0, 0));
  }

  it('incomingAt sanity: the constructed ball lands at the origin', () => {
    const land = landingPoint(incomingAt(3));
    expect(land.x).toBeCloseTo(0, 8);
    expect(land.z).toBeCloseTo(0, 8);
  });

  it('IMMOVABLE: catches with ZERO rng calls even when every roll would miss', () => {
    const h = makeDeps(); // default rng 0.999 — a miss for every roster pCatch
    const m = createFieldingModule([at(jonty, 5, 5)], h.deps);
    const event = m.tick(DT, ball(vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5)), true, null);
    expect(event).toEqual({ kind: 'caught', by: 'jonty' });
    expect(m.holderId()).toBe('jonty');
    expect(h.rngCallCount()).toBe(0); // guaranteed: the pCatch roll is skipped entirely
  });

  describe('LONG_REACH', () => {
    const base = catchRadius(laurie.stats.reach);
    const d = base * 1.2; // strictly between the base radius and the stationary radius

    it('sanity: 1.2× base sits strictly inside the LONG_REACH stationary radius', () => {
      expect(d).toBeGreaterThan(base);
      expect(d).toBeLessThan(base * ABILITY.LONG_REACH_RADIUS_MULT);
    });

    it('a STATIONARY fielder catches at 1.2× the base radius (exactly one roll)', () => {
      const h = makeDeps([0]);
      const m = createFieldingModule([at(laurie, 0, 0)], h.deps);
      const event = m.tick(DT, incomingAt(d), true, null);
      expect(event).toEqual({ kind: 'caught', by: 'laurie' });
      expect(h.rngCallCount()).toBe(1); // LONG_REACH is not guaranteed: normal one-roll contract
    });

    it('the SAME hands→ball distance is out of reach mid-chase (multiplier is stationary-only)', () => {
      const h = makeDeps([0]);
      const start = 1.2;
      // She chases the landing point (0, 0) this tick; place the ball so that
      // AFTER the move the hands→ball distance is exactly d.
      const travel = moveSpeed(laurie.stats.speed, fatigueMult(laurie.stats.stamina)) * DT;
      const postMoveX = start - travel;
      const m = createFieldingModule([at(laurie, start, 0)], h.deps);
      const event = m.tick(DT, incomingAt(postMoveX + d), true, null);
      expect(event).toBeNull();
      expect(h.rngCallCount()).toBe(0); // outside the un-multiplied radius: no entry, no roll
      expect(view(m).x).toBeCloseTo(postMoveX, 8); // sanity: she really was mid-chase this tick
    });
  });

  describe('POWERHOUSE', () => {
    const base = catchRadius(ricy.stats.reach);

    it('sanity: the probe distances straddle the +0.5 m bonus ring', () => {
      expect(0.25).toBeLessThan(ABILITY.POWERHOUSE_RADIUS_BONUS_M);
      expect(0.6).toBeGreaterThan(ABILITY.POWERHOUSE_RADIUS_BONUS_M);
    });

    it('+0.5 m additive radius: inside the bonus ring rolls once and catches', () => {
      const h = makeDeps([0]);
      const m = createFieldingModule([at(ricy, 0, 0)], h.deps);
      const event = m.tick(DT, incomingAt(base + 0.25), true, null);
      expect(event).toEqual({ kind: 'caught', by: 'ricy' });
      expect(h.rngCallCount()).toBe(1);
    });

    it('beyond base + bonus there is no attempt at all', () => {
      const h = makeDeps([0]);
      const m = createFieldingModule([at(ricy, 0, 0)], h.deps);
      const event = m.tick(DT, incomingAt(base + 0.6), true, null);
      expect(event).toBeNull();
      expect(h.rngCallCount()).toBe(0);
    });

    it('fatigueMult is forced to 1 while stamina ≥ the floor; a same-speed neutral fielder is slower', () => {
      expect(ricy.stats.speed).toBe(carl.stats.speed); // same speed stat → like-for-like advance
      expect(2.5).toBeGreaterThanOrEqual(ABILITY.POWERHOUSE_FATIGUE_FLOOR);
      expect(fatigueMult(2.5)).toBeLessThan(1); // the neutral fielder is genuinely fatigued at 2.5
      const mR = createFieldingModule([{ ...at(ricy, 0, 0), stamina: 2.5 }], makeDeps().deps);
      const mC = createFieldingModule([{ ...at(carl, 0, 0), stamina: 2.5 }], makeDeps().deps);
      mR.tick(DT, rolling(1000, 0), true, null);
      mC.tick(DT, rolling(1000, 0), true, null);
      expect(view(mR).x).toBeCloseTo(moveSpeed(ricy.stats.speed, 1) * DT, 10);
      expect(view(mC).x).toBeCloseTo(moveSpeed(carl.stats.speed, fatigueMult(2.5)) * DT, 10);
      expect(view(mR).x).toBeGreaterThan(view(mC).x);
    });

    it('below the floor normal fatigue resumes', () => {
      expect(1.5).toBeLessThan(ABILITY.POWERHOUSE_FATIGUE_FLOOR);
      const m = createFieldingModule([{ ...at(ricy, 0, 0), stamina: 1.5 }], makeDeps().deps);
      m.tick(DT, rolling(1000, 0), true, null);
      expect(view(m).x).toBeCloseTo(moveSpeed(ricy.stats.speed, fatigueMult(1.5)) * DT, 10);
    });
  });

  describe('QUICK_DRAW', () => {
    it('releases the throw at HALF the neutral delay', () => {
      const HANDS = vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5);
      const h = makeDeps([0]);
      const m = createFieldingModule([at(josh, 5, 5)], h.deps);
      expect(m.tick(DT, ball(HANDS), true, null)).toEqual({ kind: 'caught', by: 'josh' });
      const halved = GAME.THROW_RELEASE_DELAY_S * ABILITY.QUICK_DRAW_DELAY_MULT;
      expect(halved).toBeLessThan(GAME.THROW_RELEASE_DELAY_S); // a neutral holder would still be holding
      // Two half-delay ticks (0.125 s each — exact in binary): the first is
      // still short of the halved delay, the second reaches it exactly.
      expect(m.tick(halved / 2, ball(HANDS), true, 2)).toBeNull();
      expect(m.tick(halved / 2, ball(HANDS), true, 2)).toEqual({
        kind: 'thrown',
        by: 'josh',
        atPost: 2,
      });
      expect(h.throws).toHaveLength(1);
    });
  });

  describe('BUTTERFINGERS', () => {
    // joe's rng contract per radius entry is [pCatch roll, fumble roll]; the
    // fumble roll happens ONLY after a won attempt (fumbleChance 0.35 > 0).
    const HANDS = vec(5, PHYSICS.BALL_RELEASE_HEIGHT, 5);

    it('a won roll followed by a fumble roll parks the ball at the FEET: no event, no holder', () => {
      const h = makeDeps([0, 0]); // win pCatch, then 0 < 0.35 → fumble
      const m = createFieldingModule([at(joe, 5, 5)], h.deps);
      const event = m.tick(DT, ball(HANDS), true, null);
      expect(event).toBeNull();
      expect(m.holderId()).toBeNull();
      expect(view(m).hasBall).toBe(false);
      expect(h.rngCallCount()).toBe(2);
      // Parked on the GROUND at the fielder's feet — not held at the hands.
      expect(h.holds).toEqual([vec(5, PHYSICS.BALL_RADIUS, 5)]);
    });

    it('the fumbling fielder stays latched: no instant re-roll while the ball sits in radius', () => {
      const h = makeDeps([0, 0]);
      const m = createFieldingModule([at(joe, 5, 5)], h.deps);
      m.tick(DT, ball(HANDS), true, null); // fumble (rolls 1-2)
      const again = m.tick(DT, ball(HANDS), true, null); // ball still within joe's radius
      expect(again).toBeNull();
      expect(h.rngCallCount()).toBe(2); // latch held: no third roll
    });

    it('a won roll that survives the fumble roll is a normal catch (two rng calls)', () => {
      const h = makeDeps([0, 0.999]); // win pCatch, then 0.999 ≥ 0.35 → no fumble
      const m = createFieldingModule([at(joe, 5, 5)], h.deps);
      const event = m.tick(DT, ball(HANDS), true, null);
      expect(event).toEqual({ kind: 'caught', by: 'joe' });
      expect(m.holderId()).toBe('joe');
      expect(h.rngCallCount()).toBe(2);
      expect(h.holds).toEqual([HANDS]); // held at the hands like any catch
    });

    it('a neutral fielder makes NO fumble roll (call count unchanged from M4)', () => {
      const h = makeDeps([0]);
      const m = createFieldingModule([at(carl, 5, 5)], h.deps);
      const event = m.tick(DT, ball(HANDS), true, null);
      expect(event).toEqual({ kind: 'caught', by: 'carl' });
      expect(h.rngCallCount()).toBe(1); // pCatch roll only — fumbleChance 0 skips the extra call
    });

    it('a fumble ends the tick: no other fielder attempts the stale ball snapshot; the pickup next tick is GATHERED even for a guaranteed catcher', () => {
      const h = makeDeps([0, 0]);
      // Both radii contain the ball; joe (setup order first) wins then fumbles.
      const m = createFieldingModule([at(joe, 5, 5), at(jonty, 5.5, 5)], h.deps);
      const event = m.tick(DT, ball(HANDS), true, null);
      expect(event).toBeNull(); // jonty (guaranteed) never attempts — the ball is already grounded
      expect(m.holderId()).toBeNull();
      expect(h.rngCallCount()).toBe(2);
      // Next tick the parked ball (at joe's feet) is in jonty's radius: his
      // guaranteed pickup classifies gathered — the flight was fumbled.
      const pickup = m.tick(DT, rolling(5, 5), true, null);
      expect(pickup).toEqual({ kind: 'gathered', by: 'jonty' });
      expect(h.rngCallCount()).toBe(2); // guaranteed pickup: still no further rolls
    });

    it('after a fumble any later catch this flight is gathered even when hasBounced() says false (room stub coupling)', () => {
      // The room binds holdBallAt to physics.spawnBall, whose placeBall RESETS
      // the bounce flag — so after the fumble park, the physics reports the
      // grounded ball as never-bounced. Couple the stubs the same way (like
      // the M4 final-review regression test) and pin that the module's own
      // fumbledFlight flag closes the wrongful-out trap.
      const h = makeDeps([0, 0, 0]); // joe wins, joe fumbles, carl wins
      const parkAndReset = h.deps.holdBallAt;
      h.deps.holdBallAt = (p) => {
        h.bounced.value = false; // exactly what placeBall does
        parkAndReset(p);
      };
      const m = createFieldingModule([at(joe, 5, 5), at(carl, 30, 30)], h.deps);
      expect(m.tick(DT, ball(HANDS), true, null)).toBeNull(); // fumble at joe's feet
      expect(h.bounced.value).toBe(false); // the coupled stub genuinely reports no bounce
      const event = m.tick(DT, ball(vec(30, PHYSICS.BALL_RELEASE_HEIGHT, 30)), true, null);
      expect(event).toEqual({ kind: 'gathered', by: 'carl' }); // never 'caught' after a fumble
    });

    it('reset() clears the fumbled-flight flag: a fresh pre-bounce catch is caught again', () => {
      const h = makeDeps([0, 0, 0, 0.999]);
      const m = createFieldingModule([at(joe, 5, 5)], h.deps);
      m.tick(DT, ball(HANDS), true, null); // fumble (rolls 1-2)
      m.reset();
      const event = m.tick(DT, ball(HANDS), true, null); // win, survive the fumble roll (rolls 3-4)
      expect(event).toEqual({ kind: 'caught', by: 'joe' });
    });
  });
});
