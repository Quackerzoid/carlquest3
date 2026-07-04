/** Syncs render meshes to authoritative state (grows in later milestones). */
import * as THREE from 'three';
import { CONST } from '@carlquest/shared';

// Per-frame convergence factor: each view runs its own requestAnimationFrame loop and
// lerps mesh.position towards the last-known target with a TIME-based factor (not a
// fixed per-call fraction), so convergence speed is independent of framerate AND of how
// often update() is called (a single reposition patch with no further updates still
// converges smoothly — the root fix for the M8 §6.4 "capsule stuck midway" quirk).
// factor = 1 − CONVERGE_BASE^dt (dt in seconds). CONVERGE_BASE = 0.001 means after 1 s
// the remaining distance is reduced to 0.1% of its start — a "converges in about a
// second" feel, matching the previous 50%-per-patch smoothing's rough sense of snappiness.
const CONVERGE_BASE = 0.001;

/** 1 − CONVERGE_BASE^dt, clamped to [0,1] (dt in seconds; guards against huge tab-switch gaps). */
function convergeFactor(dt: number): number {
  const f = 1 - Math.pow(CONVERGE_BASE, dt);
  return Math.min(1, Math.max(0, f));
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

export interface BallView {
  /** Call once per state patch with the latest authoritative ball position (only records the target; a self-driven rAF loop lerps towards it every frame). */
  update(x: number, y: number, z: number, visible: boolean): void;
  /** Cancels the view's rAF loop and disposes its mesh. */
  dispose(): void;
}

export function createBallView(scene: THREE.Scene): BallView {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(CONST.PHYSICS.BALL_RADIUS * 4, 16, 12), // ×4: a real 3.6 cm ball is invisible at field scale
    new THREE.MeshLambertMaterial({ color: 0xe8483f }),
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
    },
  };
}

// Fielder/runner mesh dimensions are local view constants (no CONST entries yet —
// real body/character scale arrives with M8 positioning/draft art). Kept small and
// simple, matching the ball view's ×4 visibility scaling above.
const HUMAN_RADIUS = 0.35;
const HUMAN_HEIGHT = 1.4;
const HUMAN_EYE_HEIGHT = HUMAN_HEIGHT / 2 + HUMAN_RADIUS;

function createHumanGeometry(): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(HUMAN_RADIUS, HUMAN_HEIGHT, 4, 8);
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
  /** Raycast against the current fielder meshes; returns the hit character id, or null. */
  pickId(raycaster: THREE.Raycaster): string | null;
  /** Mark one fielder (by id) as selected for repositioning, or clear with null. */
  setSelected(id: string | null): void;
  /** Cancels the view's rAF loop and disposes all meshes. */
  dispose(): void;
}

interface FielderTarget {
  position: THREE.Vector3;
  hasBall: boolean;
}

/** Capsule per fielder, keyed by character id; meshes are added/removed as the roster changes. */
export function createFieldersView(scene: THREE.Scene): FieldersView {
  const plainMat = new THREE.MeshLambertMaterial({ color: 0x3b6ea5 });
  const holderMat = new THREE.MeshLambertMaterial({ color: 0xf5c542 }); // tint: fielder currently holding the ball
  const meshes = new Map<string, THREE.Mesh>();
  const targets = new Map<string, FielderTarget>();
  let selected: string | null = null;

  const raf = startRafLoop((dt) => {
    const factor = convergeFactor(dt);
    for (const [id, mesh] of meshes) {
      const t = targets.get(id);
      if (!t) continue;
      mesh.position.lerp(t.position, factor);
      mesh.material = t.hasBall ? holderMat : plainMat;
      const scale = id === selected ? 1.15 : 1;
      mesh.scale.setScalar(scale);
    }
  });

  return {
    update(fielders) {
      const seen = new Set<string>();
      for (const fielder of fielders) {
        seen.add(fielder.id);
        let mesh = meshes.get(fielder.id);
        if (!mesh) {
          mesh = new THREE.Mesh(createHumanGeometry(), plainMat);
          mesh.position.set(fielder.x, HUMAN_EYE_HEIGHT, fielder.z);
          scene.add(mesh);
          meshes.set(fielder.id, mesh);
        }
        let t = targets.get(fielder.id);
        if (!t) {
          t = { position: new THREE.Vector3(), hasBall: false };
          targets.set(fielder.id, t);
        }
        t.position.set(fielder.x, HUMAN_EYE_HEIGHT, fielder.z);
        t.hasBall = fielder.hasBall;
      }
      for (const [id, mesh] of meshes) {
        if (!seen.has(id)) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          meshes.delete(id);
          targets.delete(id);
          // Belt-and-braces: if the selected fielder's mesh is gone (substituted
          // out / side switch), drop the stale id so a later re-add (e.g. same id
          // returning to the roster) doesn't resurrect an unintended highlight.
          if (selected === id) selected = null;
        }
      }
    },
    pickId(raycaster) {
      const hits = raycaster.intersectObjects([...meshes.values()]);
      const first = hits[0]?.object;
      if (first === undefined) return null;
      for (const [id, mesh] of meshes) if (mesh === first) return id;
      return null;
    },
    setSelected(id) {
      selected = id;
    },
    dispose() {
      raf.cancel();
      for (const mesh of meshes.values()) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      meshes.clear();
      targets.clear();
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
  /** Marks a runner (by id) as out: red tint, topple, frozen position, retained ~1.5 s before removal even if the schema entry has already been deleted. */
  markOut(id: string): void;
  /** Cancels the view's rAF loop and disposes all meshes. */
  dispose(): void;
}

const RUNNER_OUT_RETAIN_MS = 1500;
const RUNNER_TOPPLE_Z = Math.PI / 2; // ~90°

interface RunnerTarget {
  position: THREE.Vector3;
  out: boolean;
  /** performance.now() timestamp after which a dying (out) runner's mesh may be removed, even if unseen in the latest update(). */
  dyingUntil: number | null;
}

/** Capsule per runner, keyed by character id; meshes are added/removed as runners spawn and settle (M5 multi-runner). Out runners topple, tint red, and are retained briefly before removal (markOut). */
export function createRunnersView(scene: THREE.Scene): RunnersView {
  const material = new THREE.MeshLambertMaterial({ color: 0xe8e8e8 });
  const outMat = new THREE.MeshLambertMaterial({ color: 0xc0392b }); // dedicated red tint for out runners
  const meshes = new Map<string, THREE.Mesh>();
  const targets = new Map<string, RunnerTarget>();

  const raf = startRafLoop((dt) => {
    const factor = convergeFactor(dt);
    for (const [id, mesh] of meshes) {
      const t = targets.get(id);
      if (!t) continue;
      if (t.dyingUntil !== null) {
        // Toppled/dying runners freeze in place — no further lerp — and keep the
        // topple rotation + red tint until removed.
        continue;
      }
      mesh.position.lerp(t.position, factor);
      mesh.visible = !t.out;
    }
  });

  return {
    update(runners) {
      const seen = new Set<string>();
      for (const runner of runners) {
        seen.add(runner.id);
        let mesh = meshes.get(runner.id);
        if (!mesh) {
          mesh = new THREE.Mesh(createHumanGeometry(), material);
          mesh.position.set(runner.x, HUMAN_EYE_HEIGHT, runner.z);
          scene.add(mesh);
          meshes.set(runner.id, mesh);
        }
        let t = targets.get(runner.id);
        if (!t) {
          t = { position: new THREE.Vector3(), out: false, dyingUntil: null };
          targets.set(runner.id, t);
        }
        // A dying (toppled) runner keeps its frozen position/rotation regardless of
        // fresh schema data until its retain window expires — markOut owns the visual
        // from that point on.
        if (t.dyingUntil === null) {
          t.position.set(runner.x, HUMAN_EYE_HEIGHT, runner.z);
          t.out = runner.out;
          mesh.visible = !runner.out;
        }
      }
      const now = performance.now();
      for (const [id, mesh] of meshes) {
        const t = targets.get(id);
        const dying = t?.dyingUntil ?? null;
        if (seen.has(id)) continue;
        // Not present in this patch (schema entry deleted). Remove immediately unless
        // still within its dying retain window.
        if (dying !== null && now < dying) continue;
        scene.remove(mesh);
        mesh.geometry.dispose();
        meshes.delete(id);
        targets.delete(id);
      }
    },
    markOut(id) {
      const mesh = meshes.get(id);
      const t = targets.get(id);
      if (!mesh || !t) return;
      mesh.material = outMat;
      mesh.visible = true;
      mesh.rotation.z = RUNNER_TOPPLE_Z;
      t.dyingUntil = performance.now() + RUNNER_OUT_RETAIN_MS;
    },
    dispose() {
      raf.cancel();
      for (const mesh of meshes.values()) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      meshes.clear();
      targets.clear();
    },
  };
}
