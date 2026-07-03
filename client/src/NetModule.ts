/** Colyseus connection (grows into the full NetModule in Milestone 6). */
import { Client, type Room } from 'colyseus.js';
import type { PitchInput, RunDecisionInput, SwingInput, PlayOutcome } from '@carlquest/shared';

const SERVER_URL = `ws://${location.hostname}:2567`;

/** Runtime shape of a FielderSchema entry (server/src/rooms/MatchState.ts). */
export interface FielderState {
  id: string;
  x: number;
  z: number;
  hasBall: boolean;
  stamina: number;
}

/** Runtime shape of RunnerSchema (server/src/rooms/MatchState.ts). */
export interface RunnerState {
  id: string;
  x: number;
  z: number;
  atPost: number;
  running: boolean;
  out: boolean;
}

/** Runtime shape of MatchState as seen by the client (server/src/rooms/MatchState.ts). */
export interface DemoState {
  ball: { x: number; y: number; z: number };
  ballLive: boolean;
  demoLog: string;
  fielders: ReadonlyMap<string, FielderState>;
  runner: RunnerState;
  lastOutcome: string;
}

export interface Net {
  room: Room<DemoState>;
  sendPitch(input: PitchInput): void;
  sendSwing(input: SwingInput & { timing: number }): void;
  sendRunDecision(input: RunDecisionInput): void;
  onPlayOutcome(callback: (outcome: PlayOutcome) => void): void;
}

export async function connect(): Promise<Net> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate<DemoState>('match');
  return {
    room,
    sendPitch(input) {
      room.send('pitch', input);
    },
    sendSwing(input) {
      room.send('swing', input);
    },
    sendRunDecision(input) {
      room.send('runDecision', input);
    },
    onPlayOutcome(callback) {
      room.onMessage('playOutcome', (outcome: PlayOutcome) => callback(outcome));
    },
  };
}
