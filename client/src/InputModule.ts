/** Keyboard → server messages for the M3 demo. Real input UI arrives with later milestones. */
import type { Net } from './NetModule';

// Demo aim constants: pitch at the batter; hit flat-ish towards mid-field (posts 1-2 gap).
const PITCH_AIM = { x: 0, y: 0, z: -1 };
const HIT_AIM = { x: 0.55, y: 0.47, z: 0.65 }; // ≈25° elevation towards mid-field

export interface InputState {
  spin: number;
}

export function attachInput(net: Net, onLocalAction: (text: string) => void): InputState {
  const state: InputState = { spin: 0 };
  window.addEventListener('keydown', (event) => {
    switch (event.code) {
      case 'KeyA':
        state.spin = -1;
        onLocalAction('spin set: -1 (left)');
        break;
      case 'KeyS':
        state.spin = 0;
        onLocalAction('spin set: 0 (straight)');
        break;
      case 'KeyD':
        state.spin = 1;
        onLocalAction('spin set: +1 (right)');
        break;
      case 'KeyP':
        if (net.myRole() !== 'fielding') break;
        net.sendPitch({ aim: PITCH_AIM, spinInput: state.spin });
        break;
      case 'Space':
        event.preventDefault();
        if (net.myRole() !== 'batting') break;
        net.sendSwing({ timing: 0, aim: HIT_AIM, spinInput: 0 });
        break;
      case 'KeyR':
        if (net.myRole() !== 'batting') break;
        net.sendRunDecision({ go: true });
        onLocalAction('run: go');
        break;
      case 'KeyT':
        if (net.myRole() !== 'batting') break;
        net.sendRunDecision({ go: false });
        onLocalAction('run: stop');
        break;
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
  });
  return state;
}
