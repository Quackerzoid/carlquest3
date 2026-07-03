import * as THREE from 'three';
import { CONST } from '@carlquest/shared';

/** Builds the static match scene: ground, pitch markings, posts, lights, camera. */
export function createScene(canvas: HTMLCanvasElement) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d9); // overcast British sky

  const { FIELD } = CONST;

  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD.GROUND_HALF_EXTENT * 2, FIELD.GROUND_HALF_EXTENT * 2),
    new THREE.MeshLambertMaterial({ color: 0x4a7c3f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Batting and bowling squares (flat outlines)
  const squareMat = new THREE.MeshBasicMaterial({ color: 0xf5f1e6 });
  for (const { pos, size } of [
    { pos: FIELD.BATTING_SQUARE, size: FIELD.BATTING_SQUARE_SIZE },
    { pos: FIELD.BOWLING_SQUARE, size: FIELD.BOWLING_SQUARE_SIZE },
  ]) {
    const square = new THREE.Mesh(new THREE.PlaneGeometry(size, size), squareMat);
    square.rotation.x = -Math.PI / 2;
    square.position.set(pos.x, 0.01, pos.z);
    scene.add(square);
  }

  // Posts
  const postGeo = new THREE.CylinderGeometry(
    FIELD.POST_RADIUS,
    FIELD.POST_RADIUS,
    FIELD.POST_HEIGHT,
    12,
  );
  const postMat = new THREE.MeshLambertMaterial({ color: 0xd9d3c7 });
  for (const post of FIELD.POSTS) {
    const mesh = new THREE.Mesh(postGeo, postMat);
    mesh.position.set(post.x, FIELD.POST_HEIGHT / 2, post.z);
    mesh.castShadow = true;
    scene.add(mesh);
  }

  // Lights
  scene.add(new THREE.HemisphereLight(0xcfe4f5, 0x3e5a35, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.position.set(20, 30, 10);
  sun.castShadow = true;
  scene.add(sun);

  // Camera: behind the batter, looking across the field
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 12, -14);
  camera.lookAt(new THREE.Vector3(2, 0, 10));

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;

  function resize(): void {
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  function start(): void {
    resize();
    window.addEventListener('resize', resize);
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
  }

  return { scene, camera, renderer, start };
}
