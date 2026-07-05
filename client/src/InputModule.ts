/**
 * Keyboard → server messages. Plays resolve automatically (autoplay redesign) —
 * the only live keys are the management ones: Enter (confirm/ready) and N (rematch).
 * Escape (clear selection) lives in PositioningControls; Home (camera reset) in
 * CameraControls.
 */
import type { Net } from './NetModule';

/** Return value of {@link attachInput}: `detach()` removes its listener. */
export interface AttachedInput {
  detach(): void;
}

/**
 * Wires up keyboard controls for one match's `net` connection.
 *
 * Registers exactly one `window` keydown listener. The caller MUST call the returned
 * `detach()` when the match ends (e.g. on `opponentLeft`, before returning to the lobby) —
 * otherwise the listener stays live bound to the abandoned `net`/room and a stale handler
 * from a previous match will keep firing (and erroring) on every subsequent keypress.
 */
export function attachInput(net: Net, onLocalAction: (text: string) => void): AttachedInput {
  const handleKeydown = (event: KeyboardEvent): void => {
    switch (event.code) {
      case 'Enter':
        // No client-side rule logic beyond choosing which message to send —
        // the server validates every message against its own phase anyway.
        if (net.phase() === 'INITIAL_POSITIONING') {
          net.sendConfirmPositioning();
          onLocalAction('confirm positioning');
        } else if (net.phase() === 'PRE_PLAY') {
          net.sendReadyForPlay();
          onLocalAction('ready for play');
        }
        break;
      case 'KeyN':
        if (net.phase() === 'GAME_OVER') {
          net.sendRematch();
          onLocalAction('rematch requested');
        }
        break;
      default:
    }
  };
  window.addEventListener('keydown', handleKeydown);
  return {
    detach: () => {
      window.removeEventListener('keydown', handleKeydown);
    },
  };
}
