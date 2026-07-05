/** Syncs render meshes to authoritative state (visual overhaul: character rigs + life animation). */
import * as THREE from 'three';
import { CHARACTERS, CONST, type Character } from '@carlquest/shared';
import {
  buildCharacterModel,
  type CharacterModel,
  type KitId,
} from './CharacterModels';

// Per-frame convergence factor: each view runs its own requestAnimationFrame loop and
// lerps group.position towards the last-known target with a TIME-based factor (not a
// fixed per-call fraction), so convergence speed is independent of framerate AND of how
// often update() is called (a single reposition patch with no further updates still
// converges smoothly — the root fix for the M8 §6.4 "capsule stuck midway" quirk).
// factor = 1 − CONVERGE_BASE^dt (dt in seconds). CONVERGE_BASE = 0.001 means after 1 s
// the remaining distance is reduced to 0.1% of its start — a "converges in about a
// second" feel, matching the previous 50%-per-patch smoothing's rough sense of snappiness.
const CONVERGE_BASE = 0.001;

// ---- Life-animation constants (purely visual; spec §4 "alive-but-simple") ----
const MOVE_EPS_M = 0.01; // frame displacement above ~1 cm counts as "moving"
const YAW_LERP_RATE = 9; // fraction-per-second rate for turning towards movement
const SWING_FREQ_BASE = 3.5; // rad/s stride phase at a crawl…
const SWING_FREQ_PER_SPEED = 1.1; // …plus this much per m/s (swing freq ∝ speed)
const SWING_AMP_MAX = 0.85; // rad, full sprint arm/leg swing (opposite phase)
const SWING_REF_SPEED = 6; // m/s at which swing amplitude saturates
const LEAN_MAX = 0.15; // rad, max forward torso lean while sprinting
const POSE_RELAX_RATE = 8; // fraction-per-second easing for amp/lean/holder pose
const BREATH_FREQ = 2.0; // rad/s idle breathing bob
const BREATH_AMP_M = 0.012; // metres of torso bob at rest — subtle
const HOLDER_ARM_COCK = -2.3; // rad: right arm raised up-and-back (throwing wind-up)
const WHALE_SWING_DAMP = 0.35; // the whale's wide arm pivots need damped swing

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

/** 1 − CONVERGE_BASE^dt, clamped to [0,1] (dt in seconds; guards against huge tab-switch gaps). */
function convergeFactor(dt: number): number {
  const f = 1 - Math.pow(CONVERGE_BASE, dt);
  return Math.min(1, Math.max(0, f));
}

/** Shortest signed angular distance a→b in (−π, π]. */
function wrapAngle(d: number): number {
  return ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
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

export function createBallView(scene: THREE.Scene): BallView {
  const texture = createBallTexture();
  const material = new THREE.MeshLambertMaterial({ map: texture });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(CONST.PHYSICS.BALL_RADIUS * 4.5, 16, 12), // ×4.5: a real 3.6 cm ball is invisible at field scale
    material,
  );
  mesh.visible = false;
  scene.add(mesh);
  const target = new THREE.Vector3();

  const raf = startRafLoop((dt) => {
    mesh.position.lerp(target, convergeFactor(dt));
  });

  return {
    update(x, y, z, visible) {
      target.set(x, y, z);
      mesh.visible = visible;
    },
    dispose() {
      raf.cancel();
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

// ---- Shared character-entry machinery for the fielders and runners views ----

interface CharEntry {
  model: CharacterModel;
  kit: KitId;
  target: THREE.Vector3;
  /** Current yaw (radians); lerped towards the movement direction. */
  facing: number;
  /** Stride phase accumulator for the sine swing. */
  phase: number;
  /** Breathing phase accumulator (idle bob). */
  breath: number;
  /** Smoothed swing amplitude (eases in/out of movement). */
  swingAmp: number;
  /** The torso pivot's built local y — breathing bob offsets from this. */
  baseTorsoY: number;
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
    swingAmp: 0,
    baseTorsoY: model.pose.torso.position.y,
  };
}

/**
 * One frame of life animation: positional lerp, yaw towards movement, speed-scaled
 * opposite-phase limb swing + torso lean, idle breathing bob, holder arm cock.
 * The whale's swing is damped (wide arm pivots — WHALE_SWING_DAMP).
 */
function animateEntry(id: string, e: CharEntry, dt: number, holder: boolean): void {
  const group = e.model.group;
  TMP_PREV.copy(group.position);
  group.position.lerp(e.target, convergeFactor(dt));
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
  const damp = id === 'whale' ? WHALE_SWING_DAMP : 1;
  const ampTarget = moving ? Math.min(1, speed / SWING_REF_SPEED) * SWING_AMP_MAX * damp : 0;
  e.swingAmp += (ampTarget - e.swingAmp) * relax;
  e.phase += dt * (SWING_FREQ_BASE + speed * SWING_FREQ_PER_SPEED);
  const swing = Math.sin(e.phase) * e.swingAmp;

  const pose = e.model.pose;
  pose.leftLeg.rotation.x = swing;
  pose.rightLeg.rotation.x = -swing;
  pose.leftArm.rotation.x = -swing;
  if (holder) {
    // Cocked throwing-arm pose overrides the swing on the right arm (carries the ball prop).
    pose.rightArm.rotation.x += (HOLDER_ARM_COCK - pose.rightArm.rotation.x) * relax;
  } else {
    pose.rightArm.rotation.x = swing;
  }

  // Torso: forward lean proportional to speed (capped), breathing bob when still.
  const lean = Math.min(LEAN_MAX, (speed / SWING_REF_SPEED) * LEAN_MAX);
  pose.torso.rotation.x += (lean - pose.torso.rotation.x) * relax;
  e.breath += dt * BREATH_FREQ;
  const bob = e.swingAmp < 0.05 ? Math.sin(e.breath) * BREATH_AMP_M : 0;
  pose.torso.position.y = e.baseTorsoY + bob;
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
  e.baseTorsoY = model.pose.torso.position.y;
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
  /** Record the drafted squads so each character renders in its side's kit ('neutral' before the draft). */
  setTeams(aIds: readonly string[], bIds: readonly string[]): void;
  /** Raycast against the current fielder models; returns the hit character id, or null. */
  pickId(raycaster: THREE.Raycaster): string | null;
  /** Mark one fielder (by id) as selected for repositioning, or clear with null. */
  setSelected(id: string | null): void;
  /**
   * Plays the bowler's wind-up → release throwing-arm animation on the pitch roll
   * broadcast (fire-and-forget; the existing rAF loop consumes the flag every frame).
   * No-op with a console.warn if `id` has no live model (matches markOut's convention —
   * a genuine ordering surprise, not a normal race, since the pitcher is always on
   * the field while PLAY is active).
   */
  windUp(id: string): void;
  /** Cancels the view's rAF loop and disposes all models. */
  dispose(): void;
}

interface FielderTarget {
  hasBall: boolean;
  /** performance.now() timestamp the current wind-up started, or null if not winding up. */
  windUpStart: number | null;
}

// ---- Wind-up timing (spec §3: "release coincides with ballLive") ----
// The room broadcasts the pitch `roll` event in the SAME tick it resolves the pitch
// and sets ballLive (MatchRoom.autoPitch) — NOT at PLAY entry; the 1.0 s
// AUTOPLAY_PITCH_DELAY_S elapses server-side BEFORE anything reaches this client.
// So the wind-up starts at actual release: the arm whips forward while the ball is
// already in its early flight, and the release-frame peak (RELEASE_FRACTION through
// the ~0.6 s animation, ≈0.36 s in) lands around the time the ball nears the batting
// plane. Live acceptance confirmed this reads correctly ("the pitcher just threw it").
// If the timing is ever reworked, broadcast the pitch roll at beat SCHEDULING rather
// than at release to run the wind-up genuinely ahead of the ball (final-review note).
const WIND_UP_DURATION_S = 0.6;
// Fraction of the animation at which the arm reaches full forward release extension —
// the back three-fifths is the cocking backswing, the last two-fifths the release snap.
const WIND_UP_RELEASE_FRACTION = 0.6;
const WIND_UP_COCK_ANGLE = -2.6; // rad: raised further back than the static HOLDER_ARM_COCK
const WIND_UP_RELEASE_ANGLE = 1.1; // rad: swung forward past vertical on release

// ---- Batter stance + swing (spec §3: "batting stance holding a bat… hands off to the
// runner rendering at contact"). The batter always faces +z (towards the bowler at
// BOWLING_SQUARE — the model's native facing), standing still, so its animation is a
// lighter dedicated loop rather than the moving-fielder machinery in animateEntry: just
// idle breathing plus the timed stance/swing pose on the pivots.
const STANCE_CROUCH = 0.08; // rad forward torso lean — a slight ready crouch
const STANCE_RIGHT_ARM = -1.05; // rad: right arm raised, bat held up and back
const STANCE_LEFT_ARM = -0.75; // rad: left arm alongside, both hands towards the bat side
const SWING_DURATION_S = 0.4;
// Swing shape: a fast forward sweep (front SWING_CONTACT_FRACTION of the animation) then
// an easing return to stance — "contact and miss both call it… a miss just follows
// through" (spec §3), so the sweep always completes the same way regardless of outcome.
const SWING_CONTACT_FRACTION = 0.45;
const SWING_ARM_FORWARD = 1.7; // rad: arms swept forward through the hitting zone
const SWING_TORSO_ROTATE = 0.9; // rad: torso twists into the swing (yaw, about y)

/** Character rig per fielder, keyed by character id; models are added/removed as the roster changes. */
export function createFieldersView(scene: THREE.Scene): FieldersView {
  const entries = new Map<string, CharEntry>();
  const flags = new Map<string, FielderTarget>();
  const groupToId = new Map<THREE.Object3D, string>();
  const teams = makeTeams();
  let selected: string | null = null;
  let clock = 0; // drives the selection-ring pulse

  const raf = startRafLoop((dt) => {
    clock += dt;
    const now = performance.now();
    for (const [id, e] of entries) {
      const f = flags.get(id);
      if (!f) continue;
      animateEntry(id, e, dt, f.hasBall);

      // Wind-up overrides the right arm (swing/holder-cock) while active. Progress is
      // wall-clock-timed from windUpStart rather than an accumulated phase, so the
      // animation always completes in exactly WIND_UP_DURATION_S regardless of frame
      // rate (matching the release-timing comment above).
      if (f.windUpStart !== null) {
        const t = (now - f.windUpStart) / 1000 / WIND_UP_DURATION_S;
        if (t >= 1) {
          f.windUpStart = null; // finished — animateEntry's own pose takes back over next frame
        } else {
          const angle =
            t < WIND_UP_RELEASE_FRACTION
              ? THREE.MathUtils.lerp(HOLDER_ARM_COCK, WIND_UP_COCK_ANGLE, t / WIND_UP_RELEASE_FRACTION)
              : THREE.MathUtils.lerp(
                  WIND_UP_COCK_ANGLE,
                  WIND_UP_RELEASE_ANGLE,
                  (t - WIND_UP_RELEASE_FRACTION) / (1 - WIND_UP_RELEASE_FRACTION),
                );
          e.model.pose.rightArm.rotation.x = angle;
        }
      }

      // Status cues (priority selected > holder for the ring; recomputed every frame
      // so any state change restores cleanly). The colour is driven through EMISSIVE
      // with the diffuse zeroed: under the warm stadium light, Lambert diffuse clips
      // gold and cream to the same rendered colour — emissive renders the status
      // colour exactly, so the two cues stay visually distinct.
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
      e.model.ball.visible = f.hasBall;
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
          f = { hasBall: false, windUpStart: null };
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
          // Belt-and-braces: if the selected fielder's model is gone (substituted
          // out / side switch), drop the stale id so a later re-add (e.g. same id
          // returning to the roster) doesn't resurrect an unintended highlight.
          if (selected === id) selected = null;
        }
      }
    },
    setTeams(aIds, bIds) {
      teams.set(aIds, bIds);
      for (const [id, e] of entries) {
        const kit = teams.kitOf(id);
        if (kit !== e.kit) rebuildEntryKit(scene, groupToId, id, e, kit);
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
        // Matches markOut's convention: this should never happen while PLAY is active
        // (the pitcher is always a live fielder), so log it as a genuine ordering
        // surprise rather than silently swallowing it.
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

  const raf = startRafLoop((dt) => {
    for (const [id, e] of entries) {
      const t = flags.get(id);
      if (!t) continue;
      if (t.dyingUntil !== null) {
        // Toppled/dying runners freeze in place — no further lerp or posing — and
        // keep the topple rotation + red tint until removed.
        continue;
      }
      animateEntry(id, e, dt, false);
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
        // Revive a dying runner whose retention has expired, or whose id has come
        // BACK to the schema after being deleted (new play / rematch re-uses the id):
        // clear the topple/tint so the revived id renders live again. A straggler
        // patch that still lists the runner before its delete lands does NOT revive
        // (dyingUntil unexpired and never absent).
        if (t.dyingUntil !== null && (t.absentWhileDying || now >= t.dyingUntil)) {
          t.dyingUntil = null;
          t.absentWhileDying = false;
          e.model.setTint(null);
          e.model.group.rotation.z = 0;
        }
        // A dying (toppled) runner keeps its frozen position/rotation regardless of
        // fresh schema data until its retain window expires — markOut owns the visual
        // from that point on.
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
        // Not present in this patch (schema entry deleted). Remove immediately unless
        // still within its dying retain window.
        if (dying !== null && now < dying) {
          if (t) t.absentWhileDying = true;
          continue;
        }
        disposeEntry(scene, groupToId, e);
        entries.delete(id);
        flags.delete(id);
      }
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
        // Dev aid only: the schema delete can legitimately beat the playOutcome
        // broadcast, in which case the mesh is already gone and there is nothing
        // to topple — but log it so a systematic ordering change is noticed.
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
   * Renders the current batter's rig at the batting square (spec §3). `batterId: null`
   * hides (and disposes) the model. `suppressed` hides WITHOUT disposing — used while a
   * runner with the same id already exists on-field (no double render), so the model can
   * reappear instantly (no rebuild) once the runner settles and the same id bats again.
   * A kit or id change always disposes and rebuilds.
   */
  update(batterId: string | null, kit: KitId, suppressed: boolean): void;
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
  baseTorsoY: number;
  /** performance.now() timestamp the current swing started, or null when idle in stance. */
  swingStart: number | null;
}

/**
 * Renders the current batter standing at CONST.FIELD.BATTING_SQUARE facing +z (towards
 * the bowler — the model's native facing, so no rotation needed), in a batting stance
 * with the bat prop visible. One model at a time; a change of id or kit disposes and
 * rebuilds (mirrors rebuildEntryKit's approach in the other views).
 */
export function createBatterView(scene: THREE.Scene): BatterView {
  let entry: BatterEntry | null = null;
  let hidden = false; // true while suppressed (runner rendering the same id) — model kept, just invisible

  const buildAt = (id: string, kit: KitId): BatterEntry => {
    const model = buildCharacterModel(charFor(id), kit);
    const bs = CONST.FIELD.BATTING_SQUARE;
    model.group.position.set(bs.x, 0, bs.z);
    model.group.rotation.y = 0; // model faces +z natively — that IS towards the bowler
    model.bat.visible = true;
    // Stance: slight crouch, both arms raised towards the bat side (right).
    model.pose.torso.rotation.x = STANCE_CROUCH;
    model.pose.rightArm.rotation.x = STANCE_RIGHT_ARM;
    model.pose.leftArm.rotation.x = STANCE_LEFT_ARM;
    scene.add(model.group);
    return {
      id,
      kit,
      model,
      breath: Math.random() * Math.PI * 2,
      baseTorsoY: model.pose.torso.position.y,
      swingStart: null,
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
        pose.rightArm.rotation.x = THREE.MathUtils.lerp(STANCE_RIGHT_ARM, SWING_ARM_FORWARD, p);
        pose.leftArm.rotation.x = THREE.MathUtils.lerp(STANCE_LEFT_ARM, SWING_ARM_FORWARD, p);
        pose.torso.rotation.y = THREE.MathUtils.lerp(0, SWING_TORSO_ROTATE, p);
        return;
      } else {
        // Follow-through/return: full extension → back to stance (contact and miss
        // both play this same return — spec §3 "a miss just follows through").
        const p = (t - SWING_CONTACT_FRACTION) / (1 - SWING_CONTACT_FRACTION);
        pose.rightArm.rotation.x = THREE.MathUtils.lerp(SWING_ARM_FORWARD, STANCE_RIGHT_ARM, p);
        pose.leftArm.rotation.x = THREE.MathUtils.lerp(SWING_ARM_FORWARD, STANCE_LEFT_ARM, p);
        pose.torso.rotation.y = THREE.MathUtils.lerp(SWING_TORSO_ROTATE, 0, p);
        return;
      }
    }
    // Idle: gentle breathing bob on top of the stance crouch — the batter stands still
    // throughout a play, so it must never look frozen. Reuses BREATH_FREQ/BREATH_AMP_M
    // from the fielder/runner idle animation for a consistent "alive" feel.
    entry.breath += dt * BREATH_FREQ;
    pose.torso.position.y = entry.baseTorsoY + Math.sin(entry.breath) * BREATH_AMP_M;
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
        entry = buildAt(batterId, kit);
      }
      hidden = suppressed;
      entry.model.group.visible = !hidden;
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
