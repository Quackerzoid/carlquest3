/**
 * Post-to-post batter-runner state machine (spec §1, §8; M4 design doc).
 * Pure logic: no physics, no RNG. The room drives tick() each frame and
 * consults exposedPost() for run-out checks — posts are the only safe stops.
 */
import { CONST, fatigueMult, moveSpeed, type Character } from '@carlquest/shared';

const { FIELD } = CONST;

export interface RunnerView {
  id: string;
  x: number;
  z: number;
  /** 0 = batting square, 1–4; non-null ONLY when halted — passing through never sets it. */
  atPost: number | null;
  /** Post being run to; null when stationary (halted, out, or home). */
  targetPost: number | null;
  out: boolean;
  /** Reached post 4 — a full circuit; the room maps this to `rounder`. */
  home: boolean;
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
  /** m/s, fixed at run start — runner stamina is static within a play in M4. */
  speed: number;
  targetPost: number | null;
  atPost: number | null;
  /** A go:false received mid-segment — halt on next post arrival. */
  stopArmed: boolean;
  out: boolean;
  home: boolean;
}

/** Waypoint for post n; a bad index is a programmer error. */
function waypoint(n: number): Waypoint {
  const p = PATH[n];
  if (p === undefined) throw new RangeError(`no post ${n}`);
  return p;
}

export function createRunningModule() {
  let state: RunnerState | null = null;

  /**
   * Spawn the runner at the batting square, already running towards post 1 —
   * hitting commits the runner (M4 design decision); a stop decision sent
   * before post 1 halts them there. Calling startRun while a runner exists
   * replaces it: the room only calls this on bat contact, once per play, so
   * replacement is reset-by-construction, not a gameplay path.
   */
  function startRun(character: Character): void {
    state = {
      id: character.id,
      x: FIELD.BATTING_SQUARE.x,
      z: FIELD.BATTING_SQUARE.z,
      // Stamina is static within a play in M4 — drain lands with multi-play
      // innings in M5 — so speed can be fixed for the whole run.
      speed: moveSpeed(character.stats.speed, fatigueMult(character.stats.stamina)),
      targetPost: 1,
      atPost: null,
      stopArmed: false,
      out: false,
      home: false,
    };
  }

  /**
   * Player stop/go (spec §7 deviation, user-approved). go mid-segment clears
   * any armed stop; go at a post resumes towards the next; go at post 4, when
   * out, or with no runner is a no-op. stop mid-segment arms halt-at-next-post;
   * stop at a post just stays.
   */
  function setDecision(go: boolean): void {
    if (state === null || state.out || state.home) return;
    if (go) {
      if (state.targetPost !== null) {
        state.stopArmed = false; // mid-segment: cancel any armed stop
      } else if (state.atPost !== null && state.atPost < HOME_POST) {
        state.targetPost = state.atPost + 1; // resume from the post
        state.atPost = null;
      }
    } else if (state.targetPost !== null) {
      state.stopArmed = true; // halt on arrival at the next post
    }
    // stop while halted at a post: already stationary — nothing to change.
  }

  /** Advance the runner along the current segment; snap-and-resolve on post arrival. */
  function tick(dt: number): void {
    if (state === null || state.out || state.targetPost === null) return;
    const target = waypoint(state.targetPost);
    const dx = target.x - state.x;
    const dz = target.z - state.z;
    const distance = Math.hypot(dx, dz);
    const travel = state.speed * dt;
    if (travel < distance) {
      state.x += (dx / distance) * travel;
      state.z += (dz / distance) * travel;
      return;
    }
    // Overshoot snaps to the post; leftover distance is discarded (one snap
    // per tick — at 1/60 s steps the loss is a fraction of one frame's travel).
    state.x = target.x;
    state.z = target.z;
    const arrived = state.targetPost;
    if (state.stopArmed || arrived === HOME_POST) {
      state.atPost = arrived;
      state.targetPost = null;
      state.stopArmed = false;
      // Post 4 = full circuit: home, and running ends permanently.
      if (arrived === HOME_POST) state.home = true;
    } else {
      // Pass straight through: atPost stays null — it is only set when halted.
      state.targetPost = arrived + 1;
    }
  }

  /** Run out: freeze in place; subsequent tick/setDecision calls no-op. */
  function markOut(): void {
    if (state === null) return;
    state.out = true;
    state.targetPost = null;
    state.stopArmed = false;
  }

  function runner(): RunnerView | null {
    if (state === null) return null;
    return {
      id: state.id,
      x: state.x,
      z: state.z,
      atPost: state.atPost,
      targetPost: state.targetPost,
      out: state.out,
      home: state.home,
    };
  }

  /**
   * The post the runner is mid-segment towards (1–4) — their run-out exposure,
   * checked by the room each tick. Null when halted at a post, out, home, or
   * when there is no runner: those runners cannot be run out.
   */
  function exposedPost(): number | null {
    if (state === null || state.out || state.home) return null;
    return state.targetPost;
  }

  /** Back to the no-runner state, ready for the next play. */
  function reset(): void {
    state = null;
  }

  return { startRun, setDecision, tick, markOut, runner, exposedPost, reset };
}
