import { describe, expect, it } from 'vitest';
import {
  CONST,
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

const carl = getCharacter('carl'); // speed 7, reach 6, pitch 5, stamina 7, instinct 6, reflex 6 → pCatch 0.72 - penalty
const josh = getCharacter('josh'); // speed 8, reach 7, stamina 7
const joe = getCharacter('joe'); // speed 2, stamina 3 — fatigues immediately

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
