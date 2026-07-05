/**
 * Clamped orbit camera: pointer-drag orbits around the pitch centre, wheel
 * zooms the radius, `Home`/double-click reset to the classic match pose.
 * Hand-rolled spherical maths (no three/examples import weight).
 */
import * as THREE from 'three';

/** Return value of {@link createCameraControls}: `detach()` removes its listeners. */
export interface CameraControls {
  /** True while a drag is in progress, or ended within the last ~150 ms (click suppression). */
  dragging(): boolean;
  /** Reset to the classic view: position (0,12,-14), lookAt (2,0,10). */
  reset(): void;
  detach(): void;
}

/** Classic match camera pose (byte-identical to SceneModule's default). */
const CLASSIC_POSITION = new THREE.Vector3(0, 12, -14);
const CLASSIC_LOOKAT = new THREE.Vector3(2, 0, 10);

/**
 * Orbit target: the pitch centre. Approximated as the midpoint of the batting
 * square (0,0) and the bowling square (0,7.5) advanced slightly further up
 * the pitch so the whole running circuit (posts extend to z≈17) stays inside
 * the framed view — (0, 0, 12) per the design brief (§4). Not derived
 * algebraically from LEGAL_ZONE/POSTS because those are asymmetric about z
 * (minZ -6, maxZ 32); a fixed, spec-approved point is simpler and matches
 * the classic camera's lookAt z of 10.
 */
const TARGET = new THREE.Vector3(0, 0, 12);

const MIN_RADIUS = 12;
const MAX_RADIUS = 55;
const MIN_POLAR = THREE.MathUtils.degToRad(10);
const MAX_POLAR = THREE.MathUtils.degToRad(80);
const DRAG_THRESHOLD_PX = 5;
const DRAG_END_HOLD_MS = 150;
const ORBIT_SPEED = 0.008; // radians per pixel of drag
const ZOOM_SPEED = 0.0015; // radians... (radius scale per wheel-delta unit)

/**
 * Wires up canvas pointer-drag orbit, wheel zoom, and `Home`/double-click
 * reset. Registers listeners on `canvas` and `window`; the caller MUST call
 * the returned `detach()` when the match ends, mirroring
 * {@link import('./PositioningControls').createPositioningControls}.
 */
export function createCameraControls(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
): CameraControls {
  // Scratch vectors, reused every frame/event — no per-call allocation.
  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();

  // Initialise spherical state FROM the current camera pose (relative to
  // TARGET) so the first drag doesn't jump.
  offset.copy(camera.position).sub(TARGET);
  spherical.setFromVector3(offset);
  spherical.radius = THREE.MathUtils.clamp(spherical.radius, MIN_RADIUS, MAX_RADIUS);
  spherical.phi = THREE.MathUtils.clamp(spherical.phi, MIN_POLAR, MAX_POLAR);

  let dragActive = false;
  let dragCrossedThreshold = false;
  let dragEndAt = 0; // performance.now() timestamp when the drag last ended
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;

  function applySpherical(): void {
    offset.setFromSpherical(spherical);
    camera.position.copy(TARGET).add(offset);
    camera.lookAt(TARGET);
  }

  function reset(): void {
    camera.position.copy(CLASSIC_POSITION);
    camera.lookAt(CLASSIC_LOOKAT);
    offset.copy(CLASSIC_POSITION).sub(TARGET);
    spherical.setFromVector3(offset);
    spherical.radius = THREE.MathUtils.clamp(spherical.radius, MIN_RADIUS, MAX_RADIUS);
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, MIN_POLAR, MAX_POLAR);
  }

  function dragging(): boolean {
    if (dragActive) return true;
    return performance.now() - dragEndAt < DRAG_END_HOLD_MS;
  }

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    dragActive = true;
    dragCrossedThreshold = false;
    startX = event.clientX;
    startY = event.clientY;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!dragActive) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    if (!dragCrossedThreshold) {
      const totalDx = event.clientX - startX;
      const totalDy = event.clientY - startY;
      if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD_PX) return;
      dragCrossedThreshold = true;
    }

    spherical.theta -= dx * ORBIT_SPEED;
    spherical.phi -= dy * ORBIT_SPEED;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, MIN_POLAR, MAX_POLAR);
    applySpherical();
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (!dragActive) return;
    dragActive = false;
    if (dragCrossedThreshold) dragEndAt = performance.now();
    dragCrossedThreshold = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const scale = Math.exp(event.deltaY * ZOOM_SPEED);
    spherical.radius = THREE.MathUtils.clamp(spherical.radius * scale, MIN_RADIUS, MAX_RADIUS);
    applySpherical();
  };

  const handleDoubleClick = (): void => {
    reset();
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Home') return;
    reset();
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('dblclick', handleDoubleClick);
  window.addEventListener('keydown', handleKeydown);

  return {
    dragging,
    reset,
    detach: () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('dblclick', handleDoubleClick);
      window.removeEventListener('keydown', handleKeydown);
    },
  };
}
