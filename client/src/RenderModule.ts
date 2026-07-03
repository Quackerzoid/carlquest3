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
