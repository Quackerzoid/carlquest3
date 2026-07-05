/** Syncs render meshes to authoritative state (readable-game overhaul: mascot rigs, walking
 * world, batting bench, full ball presentation). */
import * as THREE from 'three';
import { CHARACTERS, CONST, type Character, type MatchPhase } from '@carlquest/shared';
import {
  buildCharacterModel,
  type CharacterModel,
  type KitId,
} from './CharacterModels';

// Per-frame convergence factor for PLAY (live action): each view runs its own
// requestAnimationFrame loop and lerps group.position towards the last-known target with a
// TIME-based factor (not a fixed per-call fraction), so convergence speed is independent of
// framerate AND of how often update() is called (a single reposition patch with no further
// updates still converges smoothly — the root fix for the M8 §6.4 "capsule stuck midway"
// quirk). factor = 1 − CONVERGE_BASE^dt (dt in seconds). CONVERGE_BASE = 0.001 means after 1 s
// the remaining distance is reduced to 0.1% of its start — a "converges in about a second" feel.
const CONVERGE_BASE = 0.001;

// ---- Walking world (design §C: "no teleporting") ----
// Outside PLAY, figures do not snap or fast-converge to their targets — they WALK there at a
// human-plausible speed so a fielder returning to its slot, a repositioned figure, an innings
// swap, or a batter changing ends reads as visible motion, not a teleport. The server's
// OUTCOME_HOLD_S (1.5 s sim) leaves room for the walk to be read. The ball is exempt (it always
// flies at real speed). ≈3 m/s is a brisk walk; the field is ×2 so slots are further apart and
// a slower walk would drag, a faster one would read as a run.
const WALK_SPEED_M_S = 3;

// ---- Life-animation constants (purely visual; design §E "alive-but-simple", no legs) ----
const MOVE_EPS_M = 0.01; // frame displacement above ~1 cm counts as "moving"
const YAW_LERP_RATE = 9; // fraction-per-second rate for turning towards movement
const STRIDE_FREQ_BASE = 3.5; // rad/s body-rock phase at a crawl…
const STRIDE_FREQ_PER_SPEED = 1.1; // …plus this much per m/s (rock freq ∝ speed)
const STRIDE_AMP_MAX = 1; // normalised stride amplitude at a sprint (scales the terms below)
const STRIDE_REF_SPEED = 6; // m/s at which stride amplitude saturates
// With no legs, locomotion reads through the BODY: a vertical bob (each footfall lifts the
// blob), a side-to-side waddle roll, plus opposite-phase hand counter-pumping for an
// "arms swinging as I walk" cue. Amplitudes are small — mascots waddle, they don't march.
const WADDLE_ROLL_MAX = 0.18; // rad, max body roll (rotation.z) side-to-side at a sprint
const WALK_BOB_AMP_M = 0.05; // metres of body lift per footfall at a sprint
const HAND_PUMP_MAX = 0.6; // rad, max hand counter-swing (rotation.x) at a sprint
const LEAN_MAX = 0.15; // rad, max forward body lean (rotation.x) while sprinting
const POSE_RELAX_RATE = 8; // fraction-per-second easing for amp/lean/hand pose
const BREATH_FREQ = 2.0; // rad/s idle breathing bob
const BREATH_AMP_M = 0.012; // metres of body bob at rest — subtle
const HOLDER_HAND_RAISE = -1.1; // rad: right hand raised/forward to present the carried ball
const WHALE_STRIDE_DAMP = 0.35; // the whale is huge — damp its stride so it lumbers, not bounces

// Status-ring palette: holder = solid gold (matches the UI gold identity); selected =
// pale cream with a scale pulse so it reads as a DIFFERENT cue from the steady gold.
const RING_HOLDER = 0xd9a441;
const RING_SELECTED = 0xf4e9c8;
const SELECT_PULSE_FREQ = 6; // rad/s ring pulse
const SELECT_PULSE_AMP = 0.12; // ± scale
const OUT_TINT = 0xbb3333; // emissive red — must stay pixel-detectable (M10 technique)

// Reused scratch vectors — the rAF loops must not allocate per frame.
const TMP_PREV = new THREE.Vector3();
const TMP_DELTA = new THREE.Vector3();
const TMP_V = new THREE.Vector3();
const TMP_AXIS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TMP_Q = new THREE.Quaternion();

/** 1 − CONVERGE_BASE^dt, clamped to [0,1] (dt in seconds; guards against huge tab-switch gaps). */
function convergeFactor(dt: number): number {
  const f = 1 - Math.pow(CONVERGE_BASE, dt);
  return Math.min(1, Math.max(0, f));
}

/** Shortest signed angular distance a→b in (−π, π]. */
function wrapAngle(d: number): number {
  return ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

/**
 * Moves `pos` towards `target` for one frame under the phase-aware movement rule:
 * during PLAY it fast-converges (live action); in every other phase it walks there at
 * WALK_SPEED_M_S so nothing teleports. Returns nothing — `pos` is mutated in place.
 * The vertical (y) component is written straight through (figures live on the ground plane;
 * y is only ever 0 for characters, and posing owns any bob on top of this).
 */
function moveTowards(
  pos: THREE.Vector3,
  target: THREE.Vector3,
  dt: number,
  phase: MatchPhase,
): void {
  if (phase === 'PLAY') {
    pos.lerp(target, convergeFactor(dt));
    return;
  }
  TMP_V.subVectors(target, pos);
  const dist = TMP_V.length();
  const maxStep = WALK_SPEED_M_S * dt;
  if (dist <= maxStep || dist < 1e-6) {
    pos.copy(target);
    return;
  }
  pos.addScaledVector(TMP_V, maxStep / dist);
}

/** Drives a requestAnimationFrame loop calling `tick(dt)` each frame (dt in seconds); `cancel()` stops it. */
function startRafLoop(tick: (dt: number) => void): { cancel(): void } {
  let last = performance.now();
  let handle = 0;
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    tick(dt);
    handle = requestAnimationFrame(frame);
  };
  handle = requestAnimationFrame(frame);
  return {
    cancel() {
      cancelAnimationFrame(handle);
    },
  };
}

/**
 * Tolerant roster lookup: real ids resolve to the shared roster entry; an unknown id
 * gets a stub Character so buildCharacterModel falls back to its DEFAULT visual rather
 * than the client throwing on a surprise id from the wire.
 */
function charFor(id: string): Character {
  const found = CHARACTERS.find((c) => c.id === id);
  if (found !== undefined) return found;
  return {
    id,
    name: id,
    stats: { speed: 5, reach: 5, power: 5, pitch: 5, spin: 5, stamina: 5, reflex: 5, instinct: 5, nerve: 5 },
    ability: 'CLUTCH_SWING',
  };
}

// ==========================================================================================
// Ball presentation (design §D): rolling/tumbling, ground highlight, fading trail.
// The held-ball ICON above a holder's head lives in FieldersView (which knows holders);
// the in-hand ball prop is parented into the holder's hand sphere by CharacterModels.
// ==========================================================================================

// The state stream carries the ball's POSITION but not its velocity, so roll/tumble is driven
// from the frame-to-frame displacement of the (already-lerped) mesh — a good proxy for the
// visible motion the player sees. Rolling is a rotation about the horizontal axis ⊥ to travel;
// on the ground the angular rate is |v|/radius (a ball rolling without slipping), in the air a
// slow damped tumble so a lofted ball still spins gently rather than freezing.
const BALL_GROUND_Y = 0.25; // below this the ball is "on the ground" and rolls without slipping
const BALL_AIR_TUMBLE_RATE = 2.2; // rad/s baseline in-air tumble
const BALL_TRAIL_POINTS = 12; // fading trail sample count (design §D "~12-sample line strip")
const BALL_HIGHLIGHT_R = 0.9; // ground-projection underglow disc radius (m) — never lose the ball
const BALL_EMISSIVE_POP = 0x552018; // faint warm emissive so the ball itself never goes flat-dark

export interface BallView {
  /** Call once per state patch with the latest authoritative ball position (only records the target; a self-driven rAF loop lerps towards it every frame). */
  update(x: number, y: number, z: number, visible: boolean): void;
  /** Cancels the view's rAF loop and disposes its mesh. */
  dispose(): void;
}

/** Procedural leather-ball texture: red base with a pale stitched equatorial seam. */
function createBallTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  // Leather base with a faint vertical shade so the ball reads as rolling.
  const grad = ctx.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, '#d6493d');
  grad.addColorStop(0.5, '#c23a30');
  grad.addColorStop(1, '#a52f27');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 32);
  // Equatorial seam: two parallel pale lines with stitch ticks between them.
  ctx.strokeStyle = '#f0e3c8';
  ctx.lineWidth = 1;
  for (const y of [13.5, 18.5]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(64, y);
    ctx.stroke();
  }
  for (let x = 1; x < 64; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x + 2, 18);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Small radial-gradient sprite for the ball's ground-projection underglow (never lose the ball). */
function createHighlightTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,236,160,0.85)');
  grad.addColorStop(0.55, 'rgba(255,206,90,0.45)');
  grad.addColorStop(1, 'rgba(255,206,90,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createBallView(scene: THREE.Scene): BallView {
  const texture = createBallTexture();
  const material = new THREE.MeshLambertMaterial({ map: texture, emissive: BALL_EMISSIVE_POP });
  const radius = CONST.PHYSICS.BALL_RADIUS * 4.5; // ×4.5: a real 3.6 cm ball is invisible at field scale
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
  mesh.visible = false;
  scene.add(mesh);

  // Ground-projection highlight: a flat additive disc under the ball at y≈0, so even a
  // fast/small/lofted ball is trackable by its glow on the pitch.
  const highlightTex = createHighlightTexture();
  const highlightMat = new THREE.MeshBasicMaterial({
    map: highlightTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const highlight = new THREE.Mesh(new THREE.CircleGeometry(BALL_HIGHLIGHT_R, 24), highlightMat);
  highlight.rotation.x = -Math.PI / 2;
  highlight.position.y = 0.03;
  highlight.visible = false;
  scene.add(highlight);

  // Fading trail: a fixed-length line strip whose vertices are shuffled each frame while the
  // ball is live and whose per-vertex alpha fades from head to tail (vertexColors on a
  // LineBasicMaterial — rasteriser-cheap, no per-frame geometry rebuild, positions updated in
  // place). Cleared (collapsed to the ball) whenever the ball is not live.
  const trailGeom = new THREE.BufferGeometry();
  const trailPos = new Float32Array(BALL_TRAIL_POINTS * 3);
  const trailCol = new Float32Array(BALL_TRAIL_POINTS * 3);
  for (let i = 0; i < BALL_TRAIL_POINTS; i++) {
    const a = 1 - i / (BALL_TRAIL_POINTS - 1); // head bright → tail faded (baked into colour)
    trailCol[i * 3] = 1 * a;
    trailCol[i * 3 + 1] = 0.72 * a;
    trailCol[i * 3 + 2] = 0.45 * a;
  }
  const trailPosAttr = new THREE.BufferAttribute(trailPos, 3);
  trailGeom.setAttribute('position', trailPosAttr);
  trailGeom.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
  const trailMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 });
  const trail = new THREE.Line(trailGeom, trailMat);
  trail.visible = false;
  scene.add(trail);

  const target = new THREE.Vector3();
  let live = false;
  let trailPrimed = false;

  const primeTrail = (): void => {
    // Fill every trail sample with the current ball position (a fresh live ball has no
    // history — otherwise the strip streaks from the origin).
    for (let i = 0; i < BALL_TRAIL_POINTS; i++) {
      trailPos[i * 3] = mesh.position.x;
      trailPos[i * 3 + 1] = mesh.position.y;
      trailPos[i * 3 + 2] = mesh.position.z;
    }
    trailPosAttr.needsUpdate = true;
    trailPrimed = true;
  };

  const raf = startRafLoop((dt) => {
    TMP_PREV.copy(mesh.position);
    mesh.position.lerp(target, convergeFactor(dt));

    if (live) {
      // --- Roll / tumble from visible displacement ---
      TMP_DELTA.subVectors(mesh.position, TMP_PREV);
      const speed = dt > 0 ? TMP_DELTA.length() / dt : 0;
      if (mesh.position.y <= BALL_GROUND_Y && speed > 1e-3) {
        // Rolling without slipping: axis = up × travel, rate = |v|/radius.
        TMP_V.copy(TMP_DELTA).setY(0);
        if (TMP_V.lengthSq() > 1e-8) {
          TMP_AXIS.copy(UP).cross(TMP_V).normalize();
          const angle = (speed / radius) * dt;
          TMP_Q.setFromAxisAngle(TMP_AXIS, angle);
          mesh.quaternion.premultiply(TMP_Q);
        }
      } else {
        // In the air (or at rest): a slow damped tumble about a fixed tilted axis so a
        // lofted ball still spins gently rather than looking frozen.
        TMP_AXIS.set(0.6, 0, 0.8).normalize();
        TMP_Q.setFromAxisAngle(TMP_AXIS, BALL_AIR_TUMBLE_RATE * dt);
        mesh.quaternion.premultiply(TMP_Q);
      }

      // --- Trail: shift samples one slot down (copyWithin is a fast in-place block move that
      // avoids per-element indexed reads), then write the head to the current position ---
      trailPos.copyWithin(3, 0, (BALL_TRAIL_POINTS - 1) * 3);
      trailPos[0] = mesh.position.x;
      trailPos[1] = mesh.position.y;
      trailPos[2] = mesh.position.z;
      trailPosAttr.needsUpdate = true;

      // --- Highlight follows the ground projection ---
      highlight.position.x = mesh.position.x;
      highlight.position.z = mesh.position.z;
    }
  });

  return {
    update(x, y, z, visible) {
      target.set(x, y, z);
      const wasLive = live;
      live = visible;
      mesh.visible = visible;
      highlight.visible = visible;
      trail.visible = visible;
      if (visible && !wasLive) {
        // Newly live: snap the mesh to the spawn point and prime the trail from there so the
        // first frame doesn't streak the trail across the field from the last resting spot.
        mesh.position.set(x, y, z);
        primeTrail();
      } else if (!visible) {
        trailPrimed = false;
      }
      if (visible && !trailPrimed) primeTrail();
    },
    dispose() {
      raf.cancel();
      scene.remove(mesh);
      scene.remove(highlight);
      scene.remove(trail);
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
      highlight.geometry.dispose();
      highlightMat.dispose();
      highlightTex.dispose();
      trailGeom.dispose();
      trailMat.dispose();
    },
  };
}

/** Small canvas glyph (a stitched ball) for the bouncing "who holds the ball" icon sprite. */
function createHeldIconTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.clearRect(0, 0, size, size);
  // Soft dark halo so the glyph reads against a bright arcade-pop sky.
  const halo = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size / 2);
  halo.addColorStop(0, 'rgba(0,0,0,0.28)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  // The ball itself.
  ctx.fillStyle = '#e8483f';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  // Stitched seam.
  ctx.strokeStyle = '#f0e3c8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2 + size * 0.02, size * 0.24, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One shared held-icon texture across all fielders (identical glyph) — built lazily so a view
// with no fielders yet allocates nothing. Disposed when the last fielders view disposes.
const HELD_ICON_BOB_FREQ = 5; // rad/s bounce
const HELD_ICON_BOB_AMP = 0.15; // metres of bounce
const HELD_ICON_SIZE = 0.8; // sprite world size (m)

// ---- Shared character-entry machinery for the fielders, runners and batting views ----

interface CharEntry {
  model: CharacterModel;
  kit: KitId;
  target: THREE.Vector3;
  /** Current yaw (radians); lerped towards the movement direction. */
  facing: number;
  /** Stride phase accumulator for the body rock / hand pump. */
  phase: number;
  /** Breathing phase accumulator (idle bob). */
  breath: number;
  /** Smoothed stride amplitude (eases in/out of movement, 0..1). */
  strideAmp: number;
  /** The body pivot's built local y — bob offsets from this. */
  baseBodyY: number;
}

function createEntry(id: string, kit: KitId, x: number, z: number, facing: number): CharEntry {
  const model = buildCharacterModel(charFor(id), kit);
  model.group.position.set(x, 0, z);
  model.group.rotation.y = facing;
  return {
    model,
    kit,
    target: new THREE.Vector3(x, 0, z),
    facing,
    phase: 0,
    breath: Math.random() * Math.PI * 2, // desynchronise the roster's breathing
    strideAmp: 0,
    baseBodyY: model.pose.body.position.y,
  };
}

/**
 * One frame of life animation for a legless mascot: phase-aware positional movement (PLAY =
 * fast converge, else = walk-speed clamp), yaw towards travel, then locomotion expressed
 * through the BODY (waddle roll + walk bob + forward lean) and opposite-phase HAND pumping —
 * there are no legs. Idle = a gentle breath bob. The holder raises its right hand to present
 * the carried ball. The whale's stride is damped (it lumbers rather than bounces).
 */
function animateEntry(id: string, e: CharEntry, dt: number, phase: MatchPhase, holder: boolean): void {
  const group = e.model.group;
  TMP_PREV.copy(group.position);
  moveTowards(group.position, e.target, dt, phase);
  TMP_DELTA.subVectors(group.position, TMP_PREV);
  const dist = Math.hypot(TMP_DELTA.x, TMP_DELTA.z);
  const speed = dt > 0 ? dist / dt : 0;
  const moving = dist > MOVE_EPS_M;

  if (moving) {
    const targetYaw = Math.atan2(TMP_DELTA.x, TMP_DELTA.z);
    e.facing += wrapAngle(targetYaw - e.facing) * Math.min(1, dt * YAW_LERP_RATE);
  }
  group.rotation.y = e.facing;

  const relax = Math.min(1, dt * POSE_RELAX_RATE);
  const damp = id === 'whale' ? WHALE_STRIDE_DAMP : 1;
  const ampTarget = moving ? Math.min(1, speed / STRIDE_REF_SPEED) * STRIDE_AMP_MAX * damp : 0;
  e.strideAmp += (ampTarget - e.strideAmp) * relax;
  e.phase += dt * (STRIDE_FREQ_BASE + speed * STRIDE_FREQ_PER_SPEED);
  const rock = Math.sin(e.phase); // −1..1 side-to-side phase

  const pose = e.model.pose;
  const body = pose.body;

  // Body locomotion: waddle roll about z, walk bob (footfall = |sin| doubles the frequency of
  // the vertical lift vs the side-to-side roll — one lift per footfall), forward lean by speed.
  body.rotation.z = rock * WADDLE_ROLL_MAX * e.strideAmp;
  const lean = Math.min(LEAN_MAX, (speed / STRIDE_REF_SPEED) * LEAN_MAX);
  body.rotation.x += (lean - body.rotation.x) * relax;
  e.breath += dt * BREATH_FREQ;
  const walkBob = Math.abs(Math.sin(e.phase)) * WALK_BOB_AMP_M * e.strideAmp;
  const idleBob = e.strideAmp < 0.05 ? Math.sin(e.breath) * BREATH_AMP_M : 0;
  body.position.y = e.baseBodyY + walkBob + idleBob;

  // Hands: opposite-phase counter-pump for an "arms swinging" read. The holder overrides the
  // right hand (raised to present the carried ball) — its wind-up, when active, further
  // overrides this in FieldersView after animateEntry returns.
  const pump = rock * HAND_PUMP_MAX * e.strideAmp;
  pose.leftHand.rotation.x = pump;
  if (holder) {
    pose.rightHand.rotation.x += (HOLDER_HAND_RAISE - pose.rightHand.rotation.x) * relax;
  } else {
    pose.rightHand.rotation.x = -pump;
  }
}

/** Kit lookup for the view's current team assignment ('neutral' before the draft). */
function makeTeams(): {
  map: Map<string, KitId>;
  set(aIds: readonly string[], bIds: readonly string[]): void;
  kitOf(id: string): KitId;
} {
  const map = new Map<string, KitId>();
  return {
    map,
    set(aIds, bIds) {
      map.clear();
      for (const id of aIds) map.set(id, 'A');
      for (const id of bIds) map.set(id, 'B');
    },
    kitOf(id) {
      return map.get(id) ?? 'neutral';
    },
  };
}

/**
 * Rebuilds an entry's model in a new kit (once per character after the draft),
 * preserving position, facing and animation phase.
 */
function rebuildEntryKit(
  scene: THREE.Scene,
  groupToId: Map<THREE.Object3D, string>,
  id: string,
  e: CharEntry,
  kit: KitId,
): void {
  const old = e.model;
  const model = buildCharacterModel(charFor(id), kit);
  model.group.position.copy(old.group.position);
  model.group.rotation.copy(old.group.rotation);
  groupToId.delete(old.group);
  scene.remove(old.group);
  old.dispose();
  scene.add(model.group);
  groupToId.set(model.group, id);
  e.model = model;
  e.kit = kit;
  e.baseBodyY = model.pose.body.position.y;
}

/**
 * Raycast against all character groups (recursive) and walk the hit's parent chain up
 * to a registered group. Ring/shadow/ball prop hits count as the character (they are
 * part of the figure).
 */
function pickFromGroups(
  raycaster: THREE.Raycaster,
  groupToId: Map<THREE.Object3D, string>,
): string | null {
  const roots = [...groupToId.keys()];
  const hits = raycaster.intersectObjects(roots, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj !== null) {
      const id = groupToId.get(obj);
      if (id !== undefined) return id;
      obj = obj.parent;
    }
  }
  return null;
}

function disposeEntry(scene: THREE.Scene, groupToId: Map<THREE.Object3D, string>, e: CharEntry): void {
  groupToId.delete(e.model.group);
  scene.remove(e.model.group);
  e.model.dispose();
}

export interface FielderState {
  id: string;
  x: number;
  z: number;
  hasBall: boolean;
}

export interface FieldersView {
  /** Call once per state patch with the latest authoritative fielder set (any iterable); only records targets/state, a self-driven rAF loop lerps towards them every frame. */
  update(fielders: Iterable<FielderState>): void;
  /** Record the current match phase so movement is fast (PLAY) or walk-clamped (all other phases). */
  setPhase(phase: MatchPhase): void;
  /** Record the drafted squads so each character renders in its side's kit ('neutral' before the draft). */
  setTeams(aIds: readonly string[], bIds: readonly string[]): void;
  /** Raycast against the current fielder models; returns the hit character id, or null. */
  pickId(raycaster: THREE.Raycaster): string | null;
  /** Mark one fielder (by id) as selected for repositioning, or clear with null. */
  setSelected(id: string | null): void;
  /**
   * Plays the bowler's wind-up → release throwing animation on the pitch roll broadcast
   * (fire-and-forget; the existing rAF loop consumes the flag every frame). No-op with a
   * console.warn if `id` has no live model (matches markOut's convention).
   */
  windUp(id: string): void;
  /** Cancels the view's rAF loop and disposes all models. */
  dispose(): void;
}

interface FielderTarget {
  hasBall: boolean;
  /** performance.now() timestamp the current wind-up started, or null if not winding up. */
  windUpStart: number | null;
  /** Bouncing "holds the ball" icon sprite above the head; created lazily, kept for the view's life. */
  icon: THREE.Sprite | null;
}

// ---- Wind-up timing (design §E / spec §3: "wind-up = hand orbits back then whips") ----
// The room broadcasts the pitch `roll` event in the SAME tick it resolves the pitch and sets
// ballLive (MatchRoom.autoPitch) — the AUTOPLAY_PITCH_DELAY_S has already elapsed server-side.
// So the wind-up starts at actual release: the hand whips forward as the ball begins its
// flight. With no arm chain the motion is a rotation + small orbit of the free-standing right
// HAND group (back through the cock fraction, then a fast forward whip to release).
const WIND_UP_DURATION_S = 0.6;
// Fraction of the animation spent cocking back; the remainder is the forward release whip.
const WIND_UP_COCK_FRACTION = 0.6;
const WIND_UP_COCK_ANGLE = -2.4; // rad: hand swung up and back
const WIND_UP_RELEASE_ANGLE = 1.2; // rad: hand whipped forward past vertical on release
const WIND_UP_ORBIT_R = 0.25; // m: the hand also translates back-then-forward for a "throw" arc

// ---- Batter stance + swing (design §E / spec §3: "bat in hand-sphere sweeps"). The batter
// faces +z (towards the bowler — the model's native facing), standing still, so its animation
// is a lighter dedicated loop: idle breathing plus the timed stance/swing pose on the hands. ----
const STANCE_BODY_CROUCH = 0.08; // rad forward body lean — a slight ready crouch
const STANCE_RIGHT_HAND = -1.05; // rad: right hand raised, bat held up and back
const STANCE_LEFT_HAND = -0.75; // rad: left hand alongside, towards the bat side
const SWING_DURATION_S = 0.4;
// Swing shape: a fast forward sweep (front SWING_CONTACT_FRACTION of the animation) then an
// easing return to stance — "contact and miss both call it… a miss just follows through"
// (spec §3), so the sweep always completes the same way regardless of outcome.
const SWING_CONTACT_FRACTION = 0.45;
const SWING_HAND_FORWARD = 1.7; // rad: bat hand swept forward through the hitting zone
const SWING_BODY_ROTATE = 0.9; // rad: body twists into the swing (yaw, about y)

/** Character rig per fielder, keyed by character id; models are added/removed as the roster changes. */
export function createFieldersView(scene: THREE.Scene): FieldersView {
  const entries = new Map<string, CharEntry>();
  const flags = new Map<string, FielderTarget>();
  const groupToId = new Map<THREE.Object3D, string>();
  const teams = makeTeams();
  let selected: string | null = null;
  let phase: MatchPhase = 'LOBBY';
  let clock = 0; // drives the selection-ring pulse + icon bounce
  let iconTexture: THREE.CanvasTexture | null = null;

  const ensureIcon = (e: CharEntry): THREE.Sprite => {
    if (iconTexture === null) iconTexture = createHeldIconTexture();
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: iconTexture, transparent: true, depthTest: false }),
    );
    sprite.scale.set(HELD_ICON_SIZE, HELD_ICON_SIZE, HELD_ICON_SIZE);
    // Parented to the group so it tracks the fielder; positioned above the head (model height
    // + clearance). It bobs on y in the loop below.
    sprite.position.set(0, e.model.height + 0.7, 0);
    sprite.renderOrder = 10;
    e.model.group.add(sprite);
    return sprite;
  };

  const raf = startRafLoop((dt) => {
    clock += dt;
    const now = performance.now();
    for (const [id, e] of entries) {
      const f = flags.get(id);
      if (!f) continue;
      animateEntry(id, e, dt, phase, f.hasBall);

      // Wind-up overrides the right hand (pump/holder-raise) while active. Progress is
      // wall-clock-timed from windUpStart so the animation always completes in exactly
      // WIND_UP_DURATION_S regardless of frame rate.
      if (f.windUpStart !== null) {
        const t = (now - f.windUpStart) / 1000 / WIND_UP_DURATION_S;
        if (t >= 1) {
          f.windUpStart = null; // finished — animateEntry's own pose takes back over next frame
          e.model.pose.rightHand.position.z = 0;
        } else {
          const hand = e.model.pose.rightHand;
          if (t < WIND_UP_COCK_FRACTION) {
            const p = t / WIND_UP_COCK_FRACTION;
            hand.rotation.x = THREE.MathUtils.lerp(HOLDER_HAND_RAISE, WIND_UP_COCK_ANGLE, p);
            hand.position.z = THREE.MathUtils.lerp(0, -WIND_UP_ORBIT_R, p); // draw the hand back
          } else {
            const p = (t - WIND_UP_COCK_FRACTION) / (1 - WIND_UP_COCK_FRACTION);
            hand.rotation.x = THREE.MathUtils.lerp(WIND_UP_COCK_ANGLE, WIND_UP_RELEASE_ANGLE, p);
            hand.position.z = THREE.MathUtils.lerp(-WIND_UP_ORBIT_R, WIND_UP_ORBIT_R, p); // whip forward
          }
        }
      }

      // Status cues (priority selected > holder for the ring; recomputed every frame so any
      // state change restores cleanly). The colour is driven through EMISSIVE with the diffuse
      // zeroed: under the warm stadium light Lambert diffuse clips gold and cream to the same
      // rendered colour — emissive renders the status colour exactly, keeping the cues distinct.
      const ring = e.model.ring;
      const ringMat = ring.material as THREE.MeshLambertMaterial;
      ringMat.color.setHex(0x000000);
      if (id === selected) {
        ring.visible = true;
        ringMat.emissive.setHex(RING_SELECTED);
        ring.scale.setScalar(1 + SELECT_PULSE_AMP * Math.sin(clock * SELECT_PULSE_FREQ));
      } else if (f.hasBall) {
        ring.visible = true;
        ringMat.emissive.setHex(RING_HOLDER);
        ring.scale.setScalar(1);
      } else {
        ring.visible = false;
        ring.scale.setScalar(1);
      }

      // In-hand ball prop + bouncing head icon, both driven off hasBall.
      e.model.ball.visible = f.hasBall;
      if (f.hasBall) {
        const icon = f.icon ?? (f.icon = ensureIcon(e));
        icon.visible = true;
        icon.position.y = e.model.height + 0.7 + Math.abs(Math.sin(clock * HELD_ICON_BOB_FREQ)) * HELD_ICON_BOB_AMP;
      } else if (f.icon) {
        f.icon.visible = false;
      }
    }
  });

  return {
    update(fielders) {
      const seen = new Set<string>();
      for (const fielder of fielders) {
        seen.add(fielder.id);
        let e = entries.get(fielder.id);
        if (!e) {
          // Fielders spawn facing the batting square (spec §4 default facing).
          const bs = CONST.FIELD.BATTING_SQUARE;
          const facing = Math.atan2(bs.x - fielder.x, bs.z - fielder.z);
          e = createEntry(fielder.id, teams.kitOf(fielder.id), fielder.x, fielder.z, facing);
          scene.add(e.model.group);
          groupToId.set(e.model.group, fielder.id);
          entries.set(fielder.id, e);
        }
        let f = flags.get(fielder.id);
        if (!f) {
          f = { hasBall: false, windUpStart: null, icon: null };
          flags.set(fielder.id, f);
        }
        e.target.set(fielder.x, 0, fielder.z);
        f.hasBall = fielder.hasBall;
      }
      for (const [id, e] of entries) {
        if (!seen.has(id)) {
          disposeEntry(scene, groupToId, e);
          entries.delete(id);
          flags.delete(id);
          // Belt-and-braces: if the selected fielder's model is gone (substituted out / side
          // switch), drop the stale id so a later re-add doesn't resurrect an unintended highlight.
          if (selected === id) selected = null;
        }
      }
    },
    setPhase(p) {
      phase = p;
    },
    setTeams(aIds, bIds) {
      teams.set(aIds, bIds);
      for (const [id, e] of entries) {
        const kit = teams.kitOf(id);
        if (kit !== e.kit) {
          const f = flags.get(id);
          // The held icon is a child of the OLD group — drop the reference so ensureIcon
          // rebuilds it against the new group next time the character holds the ball.
          if (f) f.icon = null;
          rebuildEntryKit(scene, groupToId, id, e, kit);
        }
      }
    },
    pickId(raycaster) {
      return pickFromGroups(raycaster, groupToId);
    },
    setSelected(id) {
      selected = id;
    },
    windUp(id) {
      const f = flags.get(id);
      if (!f) {
        // Matches markOut's convention: this should never happen while PLAY is active (the
        // pitcher is always a live fielder), so log it as a genuine ordering surprise.
        console.warn(`FieldersView.windUp('${id}'): no live model — animation skipped`);
        return;
      }
      f.windUpStart = performance.now();
    },
    dispose() {
      raf.cancel();
      for (const e of entries.values()) disposeEntry(scene, groupToId, e);
      entries.clear();
      flags.clear();
      iconTexture?.dispose();
      iconTexture = null;
    },
  };
}

export interface RunnerState {
  id: string;
  x: number;
  z: number;
  out: boolean;
}

export interface RunnersView {
  /** Call once per state patch with the latest authoritative runner set (any iterable); only records targets/state, a self-driven rAF loop lerps towards them every frame. */
  update(runners: Iterable<RunnerState>): void;
  /** Record the current match phase so movement is fast (PLAY) or walk-clamped (all other phases). */
  setPhase(phase: MatchPhase): void;
  /** Record the drafted squads so each character renders in its side's kit ('neutral' before the draft). */
  setTeams(aIds: readonly string[], bIds: readonly string[]): void;
  /** Marks a runner (by id) as out: red tint, topple, frozen position, retained ~1.5 s before removal even if the schema entry has already been deleted. */
  markOut(id: string): void;
  /** Cancels the view's rAF loop and disposes all models. */
  dispose(): void;
}

const RUNNER_OUT_RETAIN_MS = 1500;
const RUNNER_TOPPLE_Z = Math.PI / 2; // ~90°

interface RunnerTarget {
  out: boolean;
  /** performance.now() timestamp after which a dying (out) runner's model may be removed, even if unseen in the latest update(). */
  dyingUntil: number | null;
  /** True once a dying runner has been absent from at least one patch — a later reappearance is a genuine revival (new play/rematch), not the pre-delete straggler patch. */
  absentWhileDying: boolean;
}

/** Character rig per runner, keyed by character id; models are added/removed as runners spawn and settle (M5 multi-runner). Out runners topple, tint red, and are retained briefly before removal (markOut). */
export function createRunnersView(scene: THREE.Scene): RunnersView {
  const entries = new Map<string, CharEntry>();
  const flags = new Map<string, RunnerTarget>();
  const groupToId = new Map<THREE.Object3D, string>();
  const teams = makeTeams();
  let phase: MatchPhase = 'LOBBY';

  const raf = startRafLoop((dt) => {
    for (const [id, e] of entries) {
      const t = flags.get(id);
      if (!t) continue;
      if (t.dyingUntil !== null) {
        // Toppled/dying runners freeze in place — no further lerp or posing — and keep the
        // topple rotation + red tint until removed.
        continue;
      }
      animateEntry(id, e, dt, phase, false);
      e.model.group.visible = !t.out;
    }
  });

  return {
    update(runners) {
      const now = performance.now();
      const seen = new Set<string>();
      for (const runner of runners) {
        seen.add(runner.id);
        let e = entries.get(runner.id);
        if (!e) {
          // Runners spawn facing the bowler (+z, model-native facing).
          e = createEntry(runner.id, teams.kitOf(runner.id), runner.x, runner.z, 0);
          scene.add(e.model.group);
          groupToId.set(e.model.group, runner.id);
          entries.set(runner.id, e);
        }
        let t = flags.get(runner.id);
        if (!t) {
          t = { out: false, dyingUntil: null, absentWhileDying: false };
          flags.set(runner.id, t);
        }
        // Revive a dying runner whose retention has expired, or whose id has come BACK to the
        // schema after being deleted (new play / rematch re-uses the id): clear the topple/tint
        // so the revived id renders live again. A straggler patch that still lists the runner
        // before its delete lands does NOT revive (dyingUntil unexpired and never absent).
        if (t.dyingUntil !== null && (t.absentWhileDying || now >= t.dyingUntil)) {
          t.dyingUntil = null;
          t.absentWhileDying = false;
          e.model.setTint(null);
          e.model.group.rotation.z = 0;
        }
        // A dying (toppled) runner keeps its frozen position/rotation regardless of fresh schema
        // data until its retain window expires — markOut owns the visual from that point on.
        if (t.dyingUntil === null) {
          e.target.set(runner.x, 0, runner.z);
          t.out = runner.out;
          e.model.group.visible = !runner.out;
        }
      }
      for (const [id, e] of entries) {
        const t = flags.get(id);
        const dying = t?.dyingUntil ?? null;
        if (seen.has(id)) continue;
        // Not present in this patch (schema entry deleted). Remove immediately unless still
        // within its dying retain window.
        if (dying !== null && now < dying) {
          if (t) t.absentWhileDying = true;
          continue;
        }
        disposeEntry(scene, groupToId, e);
        entries.delete(id);
        flags.delete(id);
      }
    },
    setPhase(p) {
      phase = p;
    },
    setTeams(aIds, bIds) {
      teams.set(aIds, bIds);
      for (const [id, e] of entries) {
        const kit = teams.kitOf(id);
        if (kit !== e.kit) rebuildEntryKit(scene, groupToId, id, e, kit);
      }
    },
    markOut(id) {
      const e = entries.get(id);
      const t = flags.get(id);
      if (!e || !t) {
        // Dev aid only: the schema delete can legitimately beat the playOutcome broadcast, in
        // which case the mesh is already gone and there is nothing to topple — but log it so a
        // systematic ordering change is noticed.
        console.warn(`RunnersView.markOut('${id}'): no live mesh — topple skipped`);
        return;
      }
      e.model.setTint(OUT_TINT);
      e.model.group.visible = true;
      e.model.group.rotation.z = RUNNER_TOPPLE_Z;
      t.dyingUntil = performance.now() + RUNNER_OUT_RETAIN_MS;
      t.absentWhileDying = false;
    },
    dispose() {
      raf.cancel();
      for (const e of entries.values()) disposeEntry(scene, groupToId, e);
      entries.clear();
      flags.clear();
    },
  };
}

export interface BatterView {
  /**
   * Renders the current batter's rig, walking bench→batting square (spec §3). `batterId: null`
   * hides (and disposes) the model. `suppressed` hides WITHOUT disposing — used while a runner
   * with the same id already exists on-field (no double render), so the model can reappear
   * instantly (no rebuild) once the runner settles and the same id bats again. A kit or id
   * change always disposes and rebuilds.
   */
  update(batterId: string | null, kit: KitId, suppressed: boolean): void;
  /** Record the current match phase so the batter WALKS to the square (all non-PLAY phases). */
  setPhase(phase: MatchPhase): void;
  /** Plays the bat swing (contact and miss both call it — spec §3); a miss just follows through. */
  swing(): void;
  /** Cancels the view's rAF loop and disposes the model. */
  dispose(): void;
}

interface BatterEntry {
  id: string;
  kit: KitId;
  model: CharacterModel;
  breath: number;
  baseBodyY: number;
  /** performance.now() timestamp the current swing started, or null when idle in stance. */
  swingStart: number | null;
  /** Walk target = the batting square; the figure originates at the bench and walks in. */
  target: THREE.Vector3;
}

// ---- Batting bench layout (design §C, pure client choreography — ZERO server state) ----
// Off-field batting characters sit on a bench beside the field, OUTSIDE LEGAL_ZONE on the −x
// side (screen-right of the batting end), near the batting square (z≈0). Read live from CONST
// because the field is now ×2 — never hardcode. The row runs +z from the batting end so seats
// stay clear of the fielders and the deep field. The current batter ORIGINATES at seat 0 and
// walks to the batting square; a dismissed batter walks back to a seat (the phase clamp does
// the walking either way).
const BENCH_SPACING_M = 2; // metres between adjacent seats
const BENCH_MARGIN_M = 3; // metres outside LEGAL_ZONE.minX so figures clear the touchline

/** Seat n's world position (n = 0,1,2…): a row parallel to +z, just outside LEGAL_ZONE.minX. */
function benchSeat(n: number): { x: number; z: number } {
  const x = CONST.FIELD.LEGAL_ZONE.minX - BENCH_MARGIN_M;
  const z = CONST.FIELD.BATTING_SQUARE.z + n * BENCH_SPACING_M;
  return { x, z };
}

/**
 * Renders the current batter walking from the bench to CONST.FIELD.BATTING_SQUARE and standing
 * in a batting stance with the bat prop visible, facing +z (towards the bowler — model-native,
 * no rotation needed). One model at a time; a change of id or kit disposes and rebuilds. The
 * figure spawns at bench seat 0 and walks in under the phase clamp (nothing teleports).
 */
export function createBatterView(scene: THREE.Scene): BatterView {
  let entry: BatterEntry | null = null;
  let hidden = false; // true while suppressed (runner rendering the same id) — model kept, just invisible
  let phase: MatchPhase = 'LOBBY';

  const buildWalkingIn = (id: string, kit: KitId): BatterEntry => {
    const model = buildCharacterModel(charFor(id), kit);
    // Originate at bench seat 0 so the figure visibly walks on; the batting square is the target.
    const seat = benchSeat(0);
    model.group.position.set(seat.x, 0, seat.z);
    model.group.rotation.y = 0; // model faces +z natively — that IS towards the bowler
    model.bat.visible = true;
    // Stance: slight crouch, both hands raised towards the bat side (right).
    model.pose.body.rotation.x = STANCE_BODY_CROUCH;
    model.pose.rightHand.rotation.x = STANCE_RIGHT_HAND;
    model.pose.leftHand.rotation.x = STANCE_LEFT_HAND;
    scene.add(model.group);
    const bs = CONST.FIELD.BATTING_SQUARE;
    return {
      id,
      kit,
      model,
      breath: Math.random() * Math.PI * 2,
      baseBodyY: model.pose.body.position.y,
      swingStart: null,
      target: new THREE.Vector3(bs.x, 0, bs.z),
    };
  };

  const teardown = (): void => {
    if (!entry) return;
    scene.remove(entry.model.group);
    entry.model.dispose();
    entry = null;
  };

  const raf = startRafLoop((dt) => {
    if (!entry || hidden) return;
    // Walk the figure towards the batting square (fast in PLAY, clamped walk otherwise) and
    // yaw is left native (+z) — a batter always ends up facing the bowler.
    moveTowards(entry.model.group.position, entry.target, dt, phase);
    const pose = entry.model.pose;
    if (entry.swingStart !== null) {
      const now = performance.now();
      const t = (now - entry.swingStart) / 1000 / SWING_DURATION_S;
      if (t >= 1) {
        // Swing complete — fall through to the exact stance pose below.
        entry.swingStart = null;
      } else if (t < SWING_CONTACT_FRACTION) {
        // Forward sweep: stance → full extension.
        const p = t / SWING_CONTACT_FRACTION;
        pose.rightHand.rotation.x = THREE.MathUtils.lerp(STANCE_RIGHT_HAND, SWING_HAND_FORWARD, p);
        pose.leftHand.rotation.x = THREE.MathUtils.lerp(STANCE_LEFT_HAND, SWING_HAND_FORWARD, p);
        pose.body.rotation.y = THREE.MathUtils.lerp(0, SWING_BODY_ROTATE, p);
        return;
      } else {
        // Follow-through/return: full extension → back to stance (contact and miss both play
        // this same return — spec §3 "a miss just follows through").
        const p = (t - SWING_CONTACT_FRACTION) / (1 - SWING_CONTACT_FRACTION);
        pose.rightHand.rotation.x = THREE.MathUtils.lerp(SWING_HAND_FORWARD, STANCE_RIGHT_HAND, p);
        pose.leftHand.rotation.x = THREE.MathUtils.lerp(SWING_HAND_FORWARD, STANCE_LEFT_HAND, p);
        pose.body.rotation.y = THREE.MathUtils.lerp(SWING_BODY_ROTATE, 0, p);
        return;
      }
    }
    // Idle: gentle breathing bob on top of the stance crouch — the batter stands still through
    // a play, so it must never look frozen. Reuses BREATH_FREQ/BREATH_AMP_M for a consistent feel.
    entry.breath += dt * BREATH_FREQ;
    pose.body.position.y = entry.baseBodyY + Math.sin(entry.breath) * BREATH_AMP_M;
  });

  return {
    update(batterId, kit, suppressed) {
      if (batterId === null) {
        teardown();
        hidden = false;
        return;
      }
      if (!entry || entry.id !== batterId || entry.kit !== kit) {
        teardown();
        entry = buildWalkingIn(batterId, kit);
      }
      hidden = suppressed;
      entry.model.group.visible = !hidden;
    },
    setPhase(p) {
      phase = p;
    },
    swing() {
      if (!entry || hidden) return;
      entry.swingStart = performance.now();
    },
    dispose() {
      raf.cancel();
      teardown();
    },
  };
}

// ==========================================================================================
// Batting bench (design §C): the batting side's off-field characters, seated on the bench.
// PURE CLIENT CHOREOGRAPHY — zero invented server state. Who sits: the batting squad's ids
// MINUS the current batter (BatterView renders that one, walking in to the square) MINUS any
// live runner (RunnersView renders those on the field). An OUT batter is NOT excluded — once
// the server deletes their runner entry they drop out of `runnerIds`, so they naturally flow
// back to a bench seat and sit (a FRESH untinted model — the red topple lived on the disposed
// runner model, so "tint cleared after the dying animation" happens by construction). They
// stay seated for the rest of the innings because an out batter is no longer the current
// batter nor a runner; when the innings switches sides the batting squad changes and these
// benches clear wholesale. The whale (undrafted) is never in a squad, so never rendered here.
// All derived from synced state the client already holds — squadAIds/squadBIds, battingSide,
// currentBatterId, runners.
// ==========================================================================================

export interface BenchInput {
  /** Ids drafted onto side A / B, in pick order. */
  squadAIds: readonly string[];
  squadBIds: readonly string[];
  /** Which side ('A'|'B') is currently batting; '' before a game. */
  battingSide: string;
  /** The current batter's id (rendered at the square by BatterView, so NOT benched). */
  currentBatterId: string;
  /** Live runner ids (on the field, rendered by RunnersView, so NOT benched). */
  runnerIds: Iterable<string>;
}

export interface BenchView {
  /** Recompute the seated bench from synced state (call once per state patch). */
  update(input: BenchInput): void;
  /** Record the current match phase so figures WALK to their seats (all non-PLAY phases). */
  setPhase(phase: MatchPhase): void;
  /** Record the drafted squads so each character renders in its side's kit. */
  setTeams(aIds: readonly string[], bIds: readonly string[]): void;
  /** Cancels the view's rAF loop and disposes all models. */
  dispose(): void;
}

/**
 * Seats the batting side's off-field characters on a fixed client-side bench. A newly-seated
 * character (e.g. a dismissed batter whose runner entry the server just deleted) spawns at the
 * batting square — a plausible "just came off" origin — and walks to its seat under the phase
 * clamp, so nothing teleports.
 */
export function createBenchView(scene: THREE.Scene): BenchView {
  const entries = new Map<string, CharEntry>();
  const groupToId = new Map<THREE.Object3D, string>();
  const teams = makeTeams();
  let phase: MatchPhase = 'LOBBY';

  const raf = startRafLoop((dt) => {
    for (const [id, e] of entries) {
      animateEntry(id, e, dt, phase, false);
    }
  });

  return {
    update(input) {
      const battingSquad =
        input.battingSide === 'A'
          ? input.squadAIds
          : input.battingSide === 'B'
            ? input.squadBIds
            : [];
      const runnerSet = new Set(input.runnerIds);
      // Bench = batting squad − current batter − live runners − out-this-innings.
      const benched = new Set<string>();
      for (const id of battingSquad) {
        if (id === input.currentBatterId) continue;
        if (runnerSet.has(id)) continue;
        benched.add(id);
      }

      // Assign a stable seat index per benched id (pick order within the batting squad) so a
      // character keeps the same seat frame-to-frame and figures don't shuffle seats.
      let seatIndex = 0;
      const seen = new Set<string>();
      for (const id of battingSquad) {
        if (!benched.has(id)) continue;
        seen.add(id);
        const seat = benchSeat(seatIndex);
        seatIndex += 1;
        let e = entries.get(id);
        if (!e) {
          // Newly seated: originate at the batting square (a dismissed batter has just come
          // off there) and walk out to the seat. Face +z natively; the walk yaw takes over.
          const bs = CONST.FIELD.BATTING_SQUARE;
          e = createEntry(id, teams.kitOf(id), bs.x, bs.z, 0);
          scene.add(e.model.group);
          groupToId.set(e.model.group, id);
          entries.set(id, e);
        }
        e.target.set(seat.x, 0, seat.z);
      }
      for (const [id, e] of entries) {
        if (seen.has(id)) continue;
        disposeEntry(scene, groupToId, e);
        entries.delete(id);
      }
    },
    setPhase(p) {
      phase = p;
    },
    setTeams(aIds, bIds) {
      teams.set(aIds, bIds);
      for (const [id, e] of entries) {
        const kit = teams.kitOf(id);
        if (kit !== e.kit) rebuildEntryKit(scene, groupToId, id, e, kit);
      }
    },
    dispose() {
      raf.cancel();
      for (const e of entries.values()) disposeEntry(scene, groupToId, e);
      entries.clear();
    },
  };
}
