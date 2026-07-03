import { describe, expect, it } from 'vitest';
import { CONST, fatigueMult, getCharacter, moveSpeed } from '@carlquest/shared';
import { createRunningModule, type RunnerView } from '../src/modules/RunningModule';

const { FIELD } = CONST;
const carl = getCharacter('carl');
const josh = getCharacter('josh');
const kian = getCharacter('kian');
// Carl: speed 7, stamina 7 → fatigueMult 1 → 2.5 + 5.5 * 0.7 = 6.35 m/s.
const carlSpeed = moveSpeed(carl.stats.speed, fatigueMult(carl.stats.stamina));

/** A tick large enough to snap the runner onto its target post in one step (one snap per tick). */
const SNAP = 100;

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

/** The single runner in the list, or null — most single-runner ports operate on one runner. */
function only(running: ReturnType<typeof createRunningModule>): RunnerView | null {
  return running.runners()[0] ?? null;
}

/** The runner with the given id, or undefined. */
function find(running: ReturnType<typeof createRunningModule>, id: string): RunnerView | undefined {
  return running.runners().find((r) => r.id === id);
}

/** The exposed post for the (single) runner, mirroring the old exposedPost() convenience. */
function firstExposedPost(running: ReturnType<typeof createRunningModule>): number | null {
  return running.exposures()[0]?.post ?? null;
}

describe('createRunningModule — single-runner (M4 parity, list API)', () => {
  it('pins the Carl fixture speed at 6.35 m/s', () => {
    expect(carlSpeed).toBeCloseTo(6.35, 9);
  });

  it('starts with no runners; tick/setDecision/markOut are safe no-ops', () => {
    const running = createRunningModule();
    expect(running.runners()).toEqual([]);
    expect(running.exposures()).toEqual([]);
    running.tick(1);
    running.setDecision(true);
    running.markOut('nobody');
    expect(running.runners()).toEqual([]);
  });

  it('startRun spawns at the batting square already running towards post 1', () => {
    const running = createRunningModule();
    running.startRun(carl);
    const view = only(running);
    expect(view).not.toBeNull();
    if (view !== null) {
      expect(view.id).toBe('carl');
      expect(view.x).toBe(FIELD.BATTING_SQUARE.x);
      expect(view.z).toBe(FIELD.BATTING_SQUARE.z);
      expect(view.atPost).toBeNull(); // running, not halted
      expect(view.targetPost).toBe(1);
      expect(view.out).toBe(false);
      expect(view.home).toBe(false);
      expect(view.ownHitPlay).toBe(true);
      expect(view.highestPostThisPlay).toBe(0);
    }
    expect(running.exposures()).toEqual([{ runnerId: 'carl', post: 1 }]);
  });

  it('advances along the first segment at moveSpeed (exact position after 0.5 s)', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    const expected = along(FIELD.BATTING_SQUARE, post(1), carlSpeed * 0.5);
    const view = only(running);
    expect(view?.x).toBeCloseTo(expected.x, 9);
    expect(view?.z).toBeCloseTo(expected.z, 9);
    expect(view?.atPost).toBeNull();
    expect(view?.targetPost).toBe(1);
  });

  it('passes through post 1 without stopping when no stop is armed', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    const view = only(running);
    expect(view?.x).toBe(post(1).x);
    expect(view?.z).toBe(post(1).z);
    expect(view?.atPost).toBeNull(); // passing through never sets atPost
    expect(view?.targetPost).toBe(2);
    expect(view?.highestPostThisPlay).toBe(1); // tracked on pass-through
    expect(firstExposedPost(running)).toBe(2);
  });

  it('a stop armed mid-segment halts the runner exactly at the next post', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    running.setDecision(false);
    running.tick(10);
    const view = only(running);
    expect(view?.x).toBe(post(1).x);
    expect(view?.z).toBe(post(1).z);
    expect(view?.atPost).toBe(1);
    expect(view?.targetPost).toBeNull();
    expect(firstExposedPost(running)).toBeNull(); // safe at the post
  });

  it('go: false while halted at a post keeps the runner there', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.setDecision(false);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    expect(only(running)?.atPost).toBe(1);
    running.setDecision(false);
    running.tick(1);
    expect(only(running)?.atPost).toBe(1);
    expect(only(running)?.x).toBe(post(1).x);
  });

  it('go: true at a post resumes towards the next post', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.setDecision(false);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    expect(only(running)?.atPost).toBe(1);
    running.setDecision(true);
    expect(only(running)?.atPost).toBeNull();
    expect(only(running)?.targetPost).toBe(2);
    expect(firstExposedPost(running)).toBe(2);
  });

  it('go: true mid-segment cancels an armed stop', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.3);
    running.setDecision(false);
    running.setDecision(true);
    running.tick(10);
    const view = only(running);
    expect(view?.atPost).toBeNull();
    expect(view?.targetPost).toBe(2);
    expect(firstExposedPost(running)).toBe(2);
  });

  it('reaching post 4 sets home and ends running permanently', () => {
    const running = createRunningModule();
    running.startRun(carl);
    const dt = 1 / 60;
    for (let i = 0; i < 1000 && only(running)?.home !== true; i += 1) running.tick(dt);
    const view = only(running);
    expect(view?.home).toBe(true);
    expect(view?.out).toBe(false);
    expect(view?.atPost).toBe(4);
    expect(view?.targetPost).toBeNull();
    expect(view?.highestPostThisPlay).toBe(4);
    expect(firstExposedPost(running)).toBeNull();
    running.setDecision(true);
    running.tick(1);
    expect(only(running)?.x).toBe(post(4).x);
  });

  it('markOut freezes the runner: ticks and decisions are ignored', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    running.markOut('carl');
    const frozen = only(running);
    expect(frozen?.out).toBe(true);
    expect(running.exposures()).toEqual([]);
    running.tick(1);
    running.setDecision(true);
    running.tick(1);
    const after = only(running);
    expect(after?.x).toBe(frozen?.x);
    expect(after?.out).toBe(true);
  });

  it('exposures track the target post across all four segments', () => {
    const running = createRunningModule();
    running.startRun(carl);
    expect(firstExposedPost(running)).toBe(1);
    running.tick(timeToCover(FIELD.BATTING_SQUARE, post(1)));
    expect(firstExposedPost(running)).toBe(2);
    running.tick(timeToCover(post(1), post(2)));
    expect(firstExposedPost(running)).toBe(3);
    running.tick(timeToCover(post(2), post(3)));
    expect(firstExposedPost(running)).toBe(4);
    running.tick(timeToCover(post(3), post(4)));
    expect(firstExposedPost(running)).toBeNull();
    expect(only(running)?.home).toBe(true);
  });

  it('a large single tick snaps to the post, never past it (leftover discarded)', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(SNAP);
    const view = only(running);
    expect(view?.x).toBe(post(1).x);
    expect(view?.targetPost).toBe(2);
  });

  it('reset returns to the no-runner state', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(0.5);
    running.reset();
    expect(running.runners()).toEqual([]);
    expect(running.exposures()).toEqual([]);
    running.tick(1);
    expect(running.runners()).toEqual([]);
  });
});

describe('createRunningModule — multi-runner', () => {
  /** Park a runner at post 1: run to it, halt, then settle so it survives to the next play. */
  function parkCarlAtPost1(running: ReturnType<typeof createRunningModule>): void {
    running.startRun(carl);
    running.setDecision(false);
    running.tick(SNAP); // snaps to post 1 and halts (stop armed)
    running.settlePlay();
  }

  it('setDecision applies to ALL live runners simultaneously (shared stop/go)', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running); // carl parked at post 1 (survivor)
    running.startRun(josh); // josh is the new batter-runner heading post 1

    running.setDecision(true); // resume carl off post 1, keep josh going
    // Both mid-segment now: carl → 2, josh → 1.
    expect(find(running, 'carl')?.targetPost).toBe(2);
    expect(find(running, 'josh')?.targetPost).toBe(1);

    running.setDecision(false); // shared stop arms BOTH
    running.tick(SNAP); // carl snaps to 2 & halts, josh snaps to 1 & halts
    expect(find(running, 'carl')?.atPost).toBe(2);
    expect(find(running, 'josh')?.atPost).toBe(1);
  });

  it('exposures reports every mid-segment runner (two posts for two runners)', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running);
    running.startRun(josh);
    running.setDecision(true); // carl → 2, josh → 1
    expect(running.exposures()).toEqual([
      { runnerId: 'carl', post: 2 },
      { runnerId: 'josh', post: 1 },
    ]);
  });

  it('forced on: arriving at an occupied post evicts the occupant towards the next post', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running); // carl halted at post 1
    running.startRun(josh);
    running.setDecision(false); // arm josh to halt at post 1
    running.tick(SNAP); // josh reaches post 1 (occupied) → carl forced on
    expect(find(running, 'josh')?.atPost).toBe(1); // josh took post 1
    expect(find(running, 'carl')?.atPost).toBeNull(); // carl evicted, now running
    expect(find(running, 'carl')?.targetPost).toBe(2); // towards the next post
  });

  it('forced on cascades through a chain of three runners', () => {
    const running = createRunningModule();
    // Build the chain: kian parked at post 2, carl parked at post 1.
    running.startRun(kian);
    running.tick(SNAP); // kian passes post 1 (empty), heads for post 2
    running.setDecision(false);
    running.tick(SNAP); // kian halts at post 2
    running.settlePlay(); // kian survives, parked at post 2
    running.startRun(carl);
    running.setDecision(false);
    running.tick(SNAP); // carl halts at post 1
    running.settlePlay(); // carl survives at post 1; kian still at post 2

    expect(find(running, 'carl')?.atPost).toBe(1);
    expect(find(running, 'kian')?.atPost).toBe(2);

    // josh arrives at post 1 → carl forced to 2 → kian forced to 3 (cascade).
    running.startRun(josh);
    running.setDecision(false); // arm josh to halt at post 1
    running.tick(SNAP);
    expect(find(running, 'josh')?.atPost).toBe(1);
    expect(find(running, 'carl')?.atPost).toBeNull();
    expect(find(running, 'carl')?.targetPost).toBe(2);
    expect(find(running, 'kian')?.atPost).toBeNull();
    expect(find(running, 'kian')?.targetPost).toBe(3);
  });

  it('markOut freezes only the named runner; the others are unaffected', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running);
    running.startRun(josh);
    running.setDecision(true); // carl → 2, josh → 1 (both mid-segment)
    running.markOut('josh');
    expect(find(running, 'josh')?.out).toBe(true);
    // josh no longer exposed; carl still is.
    expect(running.exposures()).toEqual([{ runnerId: 'carl', post: 2 }]);
    const joshBefore = find(running, 'josh');
    const carlBefore = find(running, 'carl');
    running.tick(0.3);
    expect(find(running, 'josh')?.x).toBe(joshBefore?.x); // frozen
    expect(find(running, 'carl')?.x).not.toBe(carlBefore?.x); // still moving
  });

  it('settlePlay reports facts for every runner (ownHit only on the batter-runner; home/out flagged)', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running); // carl: survivor at post 1 (ownHit will be false next play)
    running.startRun(josh); // josh: this play's batter-runner (ownHit true)
    running.markOut('carl'); // carl out this play
    // Drive josh home.
    for (let i = 0; i < 4; i += 1) running.tick(SNAP);
    expect(find(running, 'josh')?.home).toBe(true);

    const facts = running.settlePlay();
    const carlFact = facts.find((f) => f.runnerId === 'carl');
    const joshFact = facts.find((f) => f.runnerId === 'josh');
    expect(carlFact).toEqual({ runnerId: 'carl', ownHit: false, highestPost: 1, home: false, out: true });
    expect(joshFact).toEqual({ runnerId: 'josh', ownHit: true, highestPost: 4, home: true, out: false });
    // home and out runners are removed; no survivors remain.
    expect(running.runners()).toEqual([]);
  });

  it('settlePlay parks a mid-segment survivor at the PREVIOUS post', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.tick(SNAP); // carl passes post 1, now mid-segment towards post 2
    running.tick(0.3); // moved off post 1
    expect(find(running, 'carl')?.targetPost).toBe(2);

    const facts = running.settlePlay();
    expect(facts).toHaveLength(1);
    const view = only(running);
    expect(view?.atPost).toBe(1); // settled back to the previous post
    expect(view?.x).toBe(post(1).x);
    expect(view?.z).toBe(post(1).z);
    expect(view?.targetPost).toBeNull();
  });

  it('settlePlay collision: the trailing runner settles one post further back', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running); // carl at post 1
    running.startRun(josh);
    running.setDecision(false); // arm josh to halt at post 1
    running.tick(SNAP); // josh takes post 1; carl forced on towards post 2
    running.tick(0.3); // carl moves ahead of post 1
    // josh at post 1, carl mid-segment towards post 2 (parks at previous post = 1) → collision.

    running.settlePlay();
    // carl (ahead) keeps post 1; josh (trailing) settles one post back to the batting square (post 0).
    expect(find(running, 'carl')?.atPost).toBe(1);
    expect(find(running, 'josh')?.atPost).toBe(0);
    expect(find(running, 'josh')?.x).toBe(FIELD.BATTING_SQUARE.x);
    expect(find(running, 'josh')?.z).toBe(FIELD.BATTING_SQUARE.z);
  });

  it('settlePlay clears per-play flags: a survivor is not ownHit next play', () => {
    const running = createRunningModule();
    running.startRun(carl);
    running.setDecision(false);
    running.tick(SNAP); // carl halts at post 1
    expect(only(running)?.ownHitPlay).toBe(true);

    running.settlePlay(); // carl survives; per-play flags cleared
    expect(only(running)?.ownHitPlay).toBe(false);

    running.startRun(josh); // new batter this play
    expect(find(running, 'carl')?.ownHitPlay).toBe(false);
    expect(find(running, 'josh')?.ownHitPlay).toBe(true);

    const facts = running.settlePlay();
    expect(facts.find((f) => f.runnerId === 'carl')?.ownHit).toBe(false);
  });

  it('reset removes ALL runners (innings switch / rematch)', () => {
    const running = createRunningModule();
    parkCarlAtPost1(running);
    running.startRun(josh);
    expect(running.runners()).toHaveLength(2);
    running.reset();
    expect(running.runners()).toEqual([]);
    expect(running.exposures()).toEqual([]);
  });
});
