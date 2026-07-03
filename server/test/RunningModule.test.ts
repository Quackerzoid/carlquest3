import { describe, expect, it } from 'vitest';
import { CONST, fatigueMult, getCharacter, moveSpeed } from '@carlquest/shared';
import { createRunningModule } from '../src/modules/RunningModule';

const { FIELD } = CONST;
const carl = getCharacter('carl');
// Carl: speed 7, stamina 7 → fatigueMult 1 → 2.5 + 5.5 * 0.7 = 6.35 m/s.
const carlSpeed = moveSpeed(carl.stats.speed, fatigueMult(carl.stats.stamina));

/** Waypoint for post n (1–4); a bad index is a test-authoring error. */
function post(n: number): { x: number; z: number } {
  const p = FIELD.POSTS[n - 1];
  if (p === undefined) throw new RangeError(`no post ${n}`);
  return p;
}

/** Expected position after travelling `dist` metres from `from` towards `to`. */
function along(from: { x: number; z: number }, to: { x: number; z: number }, dist: number) {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  return {
    x: from.x + ((to.x - from.x) / length) * dist,
    z: from.z + ((to.z - from.z) / length) * dist,
  };
}

/** Seconds to run one full segment at Carl's speed, plus a nudge to guarantee arrival. */
function timeToCover(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.hypot(to.x - from.x, to.z - from.z) / carlSpeed + 0.01;
}

describe('createRunningModule', () => {
  it('pins the Carl fixture speed at 6.35 m/s', () => {
    expect(carlSpeed).toBeCloseTo(6.35, 9);
  });

  it('starts with no runner; tick/setDecision/markOut are safe no-ops', () => {
    const running = createRunningModule();
    expect(running.runner()).toBeNull();
    expect(running.exposedPost()).toBeNull();
    running.tick(1);
    running.setDecision(true);
    running.markOut();
    expect(running.runner()).toBeNull();
  });

  it('startRun spawns at the batting square already running towards post 1', () => {
    const running = createRunningModule();
    running.startRun(carl);
    const view = running.runner();
    expect(view).not.toBeNull();
    if (view !== null) {
      expect(view.id).toBe('carl');
      expect(view.x).toBe(FIELD.BATTING_SQUARE.x);
      expect(view.z).toBe(FIELD.BATTING_SQUARE.z);
      expect(view.atPost).toBeNull(); // running, not halted
      expect(view.targetPost).toBe(1);
      expect(view.out).toBe(false);
      expect(view.home).toBe(false);
    }
    expect(running.exposedPost()).toBe(1);
  });

  it('advances along the first segment at moveSpeed (exact position after 0.5 s)', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    const expected = along(FIELD.BATTING_SQUARE, post(1), carlSpeed * 0.5); // 3.175 m travelled
    const view = running.runner();
    expect(view).not.toBeNull();
    if (view !== null) {
      expect(view.x).toBeCloseTo(expected.x, 9);
      expect(view.z).toBeCloseTo(expected.z, 9);
      expect(view.atPost).toBeNull();
      expect(view.targetPost).toBe(1);
    }
  });

  it('passes through post 1 without stopping when no stop is armed', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    const view = running.runner();
    expect(view).not.toBeNull();
    if (view !== null) {
      // Snapped onto post 1 this tick, already re-targeted at post 2.
      expect(view.x).toBe(post(1).x);
      expect(view.z).toBe(post(1).z);
      expect(view.atPost).toBeNull(); // passing through never sets atPost
      expect(view.targetPost).toBe(2);
    }
    expect(running.exposedPost()).toBe(2);
    // Next tick moves off post 1 along the second segment.
    running.tick(0.5);
    const expected = along(post(1), post(2), carlSpeed * 0.5);
    const moved = running.runner();
    expect(moved).not.toBeNull();
    if (moved !== null) {
      expect(moved.x).toBeCloseTo(expected.x, 9);
      expect(moved.z).toBeCloseTo(expected.z, 9);
    }
  });

  it('a stop armed mid-segment halts the runner exactly at the next post', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    running.setDecision(false);
    running.tick(10); // far more than needed — must not run past post 1
    const view = running.runner();
    expect(view).not.toBeNull();
    if (view !== null) {
      expect(view.x).toBe(post(1).x);
      expect(view.z).toBe(post(1).z);
      expect(view.atPost).toBe(1);
      expect(view.targetPost).toBeNull();
    }
    expect(running.exposedPost()).toBeNull(); // safe at the post
    running.tick(1); // halted: further ticks do nothing
    const still = running.runner();
    expect(still?.x).toBe(post(1).x);
    expect(still?.z).toBe(post(1).z);
  });

  it('go: false while halted at a post keeps the runner there', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.setDecision(false);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    expect(running.runner()?.atPost).toBe(1);
    running.setDecision(false);
    running.tick(1);
    const view = running.runner();
    expect(view?.atPost).toBe(1);
    expect(view?.x).toBe(post(1).x);
    expect(view?.z).toBe(post(1).z);
  });

  it('go: true at a post resumes towards the next post', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.setDecision(false);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    expect(running.runner()?.atPost).toBe(1);
    running.setDecision(true);
    expect(running.runner()?.atPost).toBeNull();
    expect(running.runner()?.targetPost).toBe(2);
    expect(running.exposedPost()).toBe(2);
    running.tick(0.5);
    const expected = along(post(1), post(2), carlSpeed * 0.5);
    const view = running.runner();
    expect(view?.x).toBeCloseTo(expected.x, 9);
    expect(view?.z).toBeCloseTo(expected.z, 9);
  });

  it('go: true mid-segment cancels an armed stop', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.3);
    running.setDecision(false);
    running.setDecision(true); // change of heart — run through
    running.tick(10);
    const view = running.runner();
    expect(view?.atPost).toBeNull();
    expect(view?.targetPost).toBe(2);
    expect(running.exposedPost()).toBe(2);
  });

  it('reaching post 4 sets home and ends running permanently', () => {
    const running = createRunningModule();
    running.startRun(carl);
    const dt = 1 / 60;
    for (let i = 0; i < 1000 && running.runner()?.home !== true; i += 1) running.tick(dt);
    const view = running.runner();
    expect(view).not.toBeNull();
    if (view !== null) {
      expect(view.home).toBe(true);
      expect(view.out).toBe(false);
      expect(view.atPost).toBe(4);
      expect(view.targetPost).toBeNull();
      expect(view.x).toBe(post(4).x);
      expect(view.z).toBe(post(4).z);
    }
    expect(running.exposedPost()).toBeNull();
    // Home is terminal: neither go nor ticks move the runner again.
    running.setDecision(true);
    running.tick(1);
    const after = running.runner();
    expect(after?.x).toBe(post(4).x);
    expect(after?.z).toBe(post(4).z);
    expect(after?.targetPost).toBeNull();
  });

  it('markOut freezes the runner: ticks and decisions are ignored', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    running.markOut();
    const frozen = running.runner();
    expect(frozen?.out).toBe(true);
    expect(running.exposedPost()).toBeNull(); // an out runner exposes nothing
    running.tick(1);
    running.setDecision(true);
    running.tick(1);
    const after = running.runner();
    expect(after?.x).toBe(frozen?.x);
    expect(after?.z).toBe(frozen?.z);
    expect(after?.out).toBe(true);
  });

  it('exposedPost tracks the target post across all four segments', () => {
    const running = createRunningModule();
    running.startRun(carl);
    expect(running.exposedPost()).toBe(1);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    expect(running.exposedPost()).toBe(2);
    running.tick(timeToCover(post(1), post(2)));
    expect(running.exposedPost()).toBe(3);
    running.tick(timeToCover(post(2), post(3)));
    expect(running.exposedPost()).toBe(4);
    running.tick(timeToCover(post(3), post(4)));
    expect(running.exposedPost()).toBeNull();
    expect(running.runner()?.home).toBe(true);
  });

  it('a large single tick snaps to the post, never past it (leftover discarded)', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(100); // would cover the whole circuit many times over
    const view = running.runner();
    expect(view?.x).toBe(post(1).x);
    expect(view?.z).toBe(post(1).z);
    expect(view?.targetPost).toBe(2); // one snap per tick — no teleporting through segments
  });

  it('startRun while a runner exists replaces it', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(1);
    running.startRun(getCharacter('josh'));
    const view = running.runner();
    expect(view?.id).toBe('josh');
    expect(view?.x).toBe(FIELD.BATTING_SQUARE.x);
    expect(view?.z).toBe(FIELD.BATTING_SQUARE.z);
    expect(view?.targetPost).toBe(1);
  });

  it('reset returns to the no-runner state', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    running.reset();
    expect(running.runner()).toBeNull();
    expect(running.exposedPost()).toBeNull();
    running.tick(1); // still safe after reset
    expect(running.runner()).toBeNull();
  });
});
