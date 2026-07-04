/** Syncs render meshes to authoritative state (grows in later milestones). */
import * as THREE from 'three';
import { CONST } from '@carlquest/shared';

export interface BallView {
  /** Call once per frame with the latest authoritative ball position. */
  update(x: number, y: number, z: number, visible: boolean): void;
}

export function createBallView(scene: THREE.Scene): BallView {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(CONST.PHYSICS.BALL_RADIUS * 4, 16, 12), // ×4: a real 3.6 cm ball is invisible at field scale
    new THREE.MeshLambertMaterial({ color: 0xe8483f }),
  );
  mesh.visible = false;
  scene.add(mesh);
  const target = new THREE.Vector3();
  return {
    update(x, y, z, visible) {
      target.set(x, y, z);
      // Light smoothing towards the latest authoritative position (no client physics).
      mesh.position.lerp(target, 0.5);
      mesh.visible = visible;
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
  /** Call once per frame with the latest authoritative fielder set (any iterable). */
  update(fielders: Iterable<FielderState>): void;
  /** Raycast against the current fielder meshes; returns the hit character id, or null. */
  pickId(raycaster: THREE.Raycaster): string | null;
  /** Mark one fielder (by id) as selected for repositioning, or clear with null. */
  setSelected(id: string | null): void;
}

/** Capsule per fielder, keyed by character id; meshes are added/removed as the roster changes. */
export function createFieldersView(scene: THREE.Scene): FieldersView {
  const plainMat = new THREE.MeshLambertMaterial({ color: 0x3b6ea5 });
  const holderMat = new THREE.MeshLambertMaterial({ color: 0xf5c542 }); // tint: fielder currently holding the ball
  const meshes = new Map<string, THREE.Mesh>();
  const target = new THREE.Vector3();
  let selected: string | null = null;

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
        target.set(fielder.x, HUMAN_EYE_HEIGHT, fielder.z);
        mesh.position.lerp(target, 0.5);
        mesh.material = fielder.hasBall ? holderMat : plainMat;
        // Selection highlight: scale bump, consistent (additive) with the holder-tint
        // material swap above rather than a second competing material mechanism.
        const scale = fielder.id === selected ? 1.15 : 1;
        mesh.scale.setScalar(scale);
      }
      for (const [id, mesh] of meshes) {
        if (!seen.has(id)) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          meshes.delete(id);
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
  };
}

export interface RunnerState {
  id: string;
  x: number;
  z: number;
  out: boolean;
}

export interface RunnersView {
  /** Call once per frame with the latest authoritative runner set (any iterable). */
  update(runners: Iterable<RunnerState>): void;
}

/** Capsule per runner, keyed by character id; meshes are added/removed as runners spawn and settle (M5 multi-runner). Out runners are hidden. */
export function createRunnersView(scene: THREE.Scene): RunnersView {
  const material = new THREE.MeshLambertMaterial({ color: 0xe8e8e8 });
  const meshes = new Map<string, THREE.Mesh>();
  const target = new THREE.Vector3();

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
        target.set(runner.x, HUMAN_EYE_HEIGHT, runner.z);
        mesh.position.lerp(target, 0.5);
        mesh.visible = !runner.out;
      }
      for (const [id, mesh] of meshes) {
        if (!seen.has(id)) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          meshes.delete(id);
        }
      }
    },
  };
}
