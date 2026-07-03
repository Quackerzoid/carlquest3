/**
 * Multi-runner post-to-post state machine (spec §1, §8; M5 rules-engine design,
 * user decision 2 — shared stop/go, forced-on, full school rules). Pure logic:
 * no physics, no RNG, no wall-clock. The room drives tick() each frame and
 * consults exposures() for per-runner run-out checks — posts are the only safe
 * stops.
 *
 * Per-runner movement (moveSpeed via shared formulas, straight BATTING_SQUARE →
 * POSTS[0..3] segments, overshoot snap, stop-arms-halt-at-next-post) is the M4
 * single-runner mechanic applied to every runner in a list.
 */
import { CONST, fatigueMult, moveSpeed, type Character, type SettlementFact } from '@carlquest/shared';

const { FIELD } = CONST;

export interface RunnerView {
  id: string;
  x: number;
  z: number;
  /** 0 = batting square, 1–4; non-null when halted/parked — passing through never sets it. */
  atPost: number | null;
  /** Post being run to; null when stationary (halted, parked, out, or home). */
  targetPost: number | null;
  out: boolean;
  /** Reached post 4 — a full circuit; the rules module maps this to a score. */
  home: boolean;
  /** True only for the batter-runner of the current play; cleared on settle. */
  ownHitPlay: boolean;
  /** 0..4, highest post reached this play, monotonic within a play. */
  highestPostThisPlay: number;
}

interface Waypoint {
  x: number;
  z: number;
}

/** Waypoint n is where post n stands; index 0 is the batting square. */
const PATH: readonly Waypoint[] = [FIELD.BATTING_SQUARE, ...FIELD.POSTS];

/** The last post — arrival here is home (a rounder). */
const HOME_POST = FIELD.POSTS.length;

interface RunnerState {
  id: string;
  x: number;
  z: number;
  /** m/s, fixed at run start — runner stamina is static within a play. */
  speed: number;
  targetPost: number | null;
  atPost: number | null;
  /** A go:false received mid-segment — halt on next post arrival. */
  stopArmed: boolean;
  out: boolean;
  home: boolean;
  ownHitPlay: boolean;
  highestPostThisPlay: number;
}

/** Waypoint for post n; a bad index is a programmer error. */
function waypoint(n: number): Waypoint {
  const p = PATH[n];
  if (p === undefined) throw new RangeError(`no post ${n}`);
  return p;
}

/** A runner is live (movable, exposable) when neither out nor home. */
function isLive(r: RunnerState): boolean {
  return !r.out && !r.home;
}

export function createRunningModule() {
  let runners: RunnerState[] = [];

  /**
   * Spawn the batter-runner at the batting square, already running towards post
   * 1 — hitting commits the runner (M4 design decision); a stop sent before post
   * 1 halts them there. Parked survivors from earlier plays are untouched. The
   * room calls this once per play (on bat contact); the new runner is the only
   * one flagged ownHitPlay.
   */
  function startRun(character: Character): void {
    runners.push({
      id: character.id,
      x: FIELD.BATTING_SQUARE.x,
      z: FIELD.BATTING_SQUARE.z,
      speed: moveSpeed(character.stats.speed, fatigueMult(character.stats.stamina)),
      targetPost: 1,
      atPost: null,
      stopArmed: false,
      out: false,
      home: false,
      ownHitPlay: true,
      highestPostThisPlay: 0,
    });
  }

  /**
   * Shared player stop/go (spec §7 deviation, user-approved; applied to ALL live
   * runners simultaneously). go mid-segment clears any armed stop; go at a post
   * resumes towards the next; go at post 4, when out/home, is a no-op. stop
   * mid-segment arms halt-at-next-post; stop at a post just stays.
   */
  function setDecision(go: boolean): void {
    for (const r of runners) {
      if (!isLive(r)) continue;
      if (go) {
        if (r.targetPost !== null) {
          r.stopArmed = false; // mid-segment: cancel any armed stop
        } else if (r.atPost !== null && r.atPost < HOME_POST) {
          r.targetPost = r.atPost + 1; // resume from the post
          r.atPost = null;
        }
      } else if (r.targetPost !== null) {
        r.stopArmed = true; // halt on arrival at the next post
      }
      // stop while halted at a post: already stationary — nothing to change.
    }
  }

  /**
   * Forced on: a runner has just reached (or passed through) `post`, which no
   * runner may share. Evict whichever OTHER live runner is halted there onto the
   * next post (auto-go, overriding any armed stop) and cascade, so a whole chain
   * of stacked runners shunts forward in one resolution. `arrivingId` is excluded
   * so the runner that just claimed the post is never evicted by its own arrival.
   */
  function forceOn(post: number, arrivingId: string): void {
    const occupant = runners.find((r) => r.id !== arrivingId && isLive(r) && r.atPost === post);
    if (occupant === undefined) return;
    occupant.atPost = null;
    occupant.targetPost = post + 1;
    occupant.stopArmed = false;
    // The evicted runner now conceptually moves into post+1: shunt its occupant too.
    forceOn(post + 1, occupant.id);
  }

  /** Advance one runner along its current segment; snap-and-resolve on post arrival. Returns the post reached this tick, or null. */
  function tickRunner(r: RunnerState, dt: number): number | null {
    if (!isLive(r) || r.targetPost === null) return null;
    const target = waypoint(r.targetPost);
    const dx = target.x - r.x;
    const dz = target.z - r.z;
    const distance = Math.hypot(dx, dz);
    const travel = r.speed * dt;
    if (travel < distance) {
      r.x += (dx / distance) * travel;
      r.z += (dz / distance) * travel;
      return null;
    }
    // Overshoot snaps to the post; leftover distance is discarded (one snap per tick).
    r.x = target.x;
    r.z = target.z;
    const arrived = r.targetPost;
    r.highestPostThisPlay = Math.max(r.highestPostThisPlay, arrived);
    if (r.stopArmed || arrived === HOME_POST) {
      r.atPost = arrived;
      r.targetPost = null;
      r.stopArmed = false;
      if (arrived === HOME_POST) r.home = true; // full circuit: home, running ends
    } else {
      // Pass straight through: atPost stays null — it is only set when halted.
      r.targetPost = arrived + 1;
    }
    return arrived;
  }

  /**
   * Advance every runner one step. Halted runners do not move, so processing
   * order between a mover and a stationary occupant is immaterial. A runner that
   * reaches a post triggers forced-on for that post immediately, so an occupant
   * is shunted the moment another runner arrives at or passes through its post.
   */
  function tick(dt: number): void {
    for (const r of runners) {
      const reached = tickRunner(r, dt);
      if (reached !== null) forceOn(reached, r.id);
    }
  }

  /** Run out one specific runner: freeze in place; subsequent tick/setDecision calls skip it. Others unaffected. */
  function markOut(runnerId: string): void {
    const r = runners.find((x) => x.id === runnerId);
    if (r === undefined) return;
    r.out = true;
    r.targetPost = null;
    r.stopArmed = false;
  }

  function view(r: RunnerState): RunnerView {
    return {
      id: r.id,
      x: r.x,
      z: r.z,
      atPost: r.atPost,
      targetPost: r.targetPost,
      out: r.out,
      home: r.home,
      ownHitPlay: r.ownHitPlay,
      highestPostThisPlay: r.highestPostThisPlay,
    };
  }

  function runnerViews(): RunnerView[] {
    return runners.map(view);
  }

  /**
   * Every mid-segment runner's target post — their run-out exposure, checked by
   * the room each tick. Halted, parked, out and home runners expose nothing:
   * they cannot be run out.
   */
  function exposures(): { runnerId: string; post: number }[] {
    const out: { runnerId: string; post: number }[] = [];
    for (const r of runners) {
      if (isLive(r) && r.targetPost !== null) out.push({ runnerId: r.id, post: r.targetPost });
    }
    return out;
  }

  /** Progress along the circuit as a real number: base post + fraction of the current segment travelled. */
  function progress(r: RunnerState): number {
    if (r.atPost !== null) return r.atPost;
    if (r.targetPost === null) return 0; // unreachable for a live survivor (has atPost or targetPost)
    const prev = r.targetPost - 1;
    const from = waypoint(prev);
    const to = waypoint(r.targetPost);
    const segment = Math.hypot(to.x - from.x, to.z - from.z);
    const done = Math.hypot(r.x - from.x, r.z - from.z);
    return prev + (segment === 0 ? 0 : done / segment);
  }

  /** Where a survivor would settle: at-post runners stay; mid-segment runners drop to the previous post (M4 safe-at-previous rule). */
  function desiredPark(r: RunnerState): number {
    if (r.atPost !== null) return r.atPost;
    return (r.targetPost ?? 1) - 1;
  }

  /**
   * End-of-play settlement (replaces the M4 all-clearing reset). Returns a fact
   * per runner that existed this play, then removes home/out runners and parks
   * survivors: at-post runners stay, mid-segment runners settle at the previous
   * post. Two survivors must never share a post — parking is resolved
   * front-to-back (highest circuit progress first), and a trailing runner whose
   * desired post is already claimed is pushed one post further back (repeat until
   * free, floored at the batting square, post 0 — a legal parked position). Then
   * per-play flags (ownHitPlay, highestPostThisPlay) are cleared for the next play.
   */
  function settlePlay(): SettlementFact[] {
    const facts: SettlementFact[] = runners.map((r) => ({
      runnerId: r.id,
      ownHit: r.ownHitPlay,
      highestPost: r.highestPostThisPlay,
      home: r.home,
      out: r.out,
    }));

    const survivors = runners.filter(isLive);
    // Front-of-circuit first: the runner physically ahead claims the contested post.
    survivors.sort((a, b) => progress(b) - progress(a));
    const claimed = new Set<number>();
    for (const r of survivors) {
      let park = desiredPark(r);
      while (park > 0 && claimed.has(park)) park -= 1; // trailing runner pushed one post back per collision
      claimed.add(park);
      const wp = waypoint(park);
      r.x = wp.x;
      r.z = wp.z;
      r.atPost = park;
      r.targetPost = null;
      r.stopArmed = false;
      r.ownHitPlay = false;
      r.highestPostThisPlay = park; // reset for the next play, consistent with the parked position
    }
    runners = survivors;
    return facts;
  }

  /** Remove ALL runners — innings switch or rematch. */
  function reset(): void {
    runners = [];
  }

  return { startRun, setDecision, tick, markOut, runners: runnerViews, exposures, settlePlay, reset };
}
