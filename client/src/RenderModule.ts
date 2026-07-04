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
  /** Cancels the view's rAF loop and disposes all models. */
  dispose(): void;
}

interface FielderTarget {
  hasBall: boolean;
}

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
    for (const [id, e] of entries) {
      const f = flags.get(id);
      if (!f) continue;
      animateEntry(id, e, dt, f.hasBall);
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
          f = { hasBall: false };
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
