/** Raycast-based fielder repositioning: click a fielder to select, click the field to move it. */
import * as THREE from 'three';
import type { Net } from './NetModule';
import type { FieldersView } from './RenderModule';

/** Shared selection store: which fielder id (if any) is currently picked for repositioning. */
export interface SelectionStore {
  get(): string | null;
  set(id: string | null): void;
}

/** Return value of {@link createPositioningControls}: `detach()` removes its listeners. */
export interface PositioningControls {
  detach(): void;
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * Wires up canvas click + Escape-key controls for repositioning on-field fielders
 * during INITIAL_POSITIONING/PRE_PLAY, for the fielding side only.
 *
 * Registers a `canvas` click listener and a `window` keydown listener. The caller
 * MUST call the returned `detach()` when the match ends (e.g. on `opponentLeft`),
 * mirroring {@link import('./InputModule').attachInput} — otherwise a stale handler
 * bound to the abandoned `net`/room keeps firing on subsequent clicks/keypresses.
 */
export function createPositioningControls(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  fielders: FieldersView,
  net: Net,
  selection: SelectionStore,
  onLocalAction: (text: string) => void,
  /**
   * Optional drag suppressor (autoplay redesign §4): when the orbit camera reports a
   * drag in progress (or just ended), the click that concludes it must NOT select or
   * reposition a fielder — orbiting and click-to-reposition share the same canvas.
   */
  isDragging?: () => boolean,
): PositioningControls {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const point = new THREE.Vector3();

  function isActive(): boolean {
    const phase = net.phase();
    if (phase !== 'INITIAL_POSITIONING' && phase !== 'PRE_PLAY') return false;
    const side = net.mySide();
    if (side === null) return false;
    return side !== net.room.state.battingSide;
  }

  function pointerToRaycaster(event: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
  }

  const handleClick = (event: MouseEvent): void => {
    if (isDragging?.() === true) return; // camera-orbit drag release, not a reposition click
    if (!isActive()) return;
    pointerToRaycaster(event);

    const state = net.room.state;
    const pitcherId = state.currentPitcherId;
    const mySquad = net.mySide() === 'A' ? state.squadAIds : state.squadBIds;
    const hitId = fielders.pickId(raycaster);
    const isOwnFielder = hitId !== null && (mySquad ?? []).includes(hitId);
    if (isOwnFielder && hitId !== pitcherId) {
      selection.set(hitId);
      onLocalAction(`selected fielder`);
      return;
    }

    const selectedId = selection.get();
    if (selectedId === null) return;

    if (raycaster.ray.intersectPlane(GROUND_PLANE, point) === null) return;
    net.sendReposition({ id: selectedId, x: point.x, z: point.z });
    // Selection is kept: the server patch moves the capsule; a rejection surfaces
    // on the status line via onRejected rather than clearing the selection here.
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    selection.set(null);
  };

  canvas.addEventListener('click', handleClick);
  window.addEventListener('keydown', handleKeydown);

  return {
    detach: () => {
      canvas.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeydown);
    },
  };
}
