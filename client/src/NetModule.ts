/** Colyseus connection (grows into the full NetModule in Milestone 6). */
import { Client, type Room } from 'colyseus.js';
import type { PitchInput, SwingInput } from '@carlquest/shared';

const SERVER_URL = `ws://${location.hostname}:2567`;

/** Runtime shape of MatchState as seen by the client (server/src/rooms/MatchState.ts). */
export interface DemoState {
  ball: { x: number; y: number; z: number };
  ballLive: boolean;
  demoLog: string;
}

export interface Net {
  room: Room<DemoState>;
  sendPitch(input: PitchInput): void;
  sendSwing(input: SwingInput & { timing: number }): void;
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
  };
}
